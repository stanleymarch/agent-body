/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { agentState } from './state.js';

// SpeechRecognition is not part of every browser's DOM declarations or runtime.
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface RecognitionWindow extends Window {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
}

export interface ListeningSession {
  readonly active: boolean;
  /** Finish recording and deliver the transcript when recognition completes. */
  stop(): void;
  /** Discard this session, abort uploads, and never deliver its transcript. */
  cancel(): void;
}

let active: ListeningSession | null = null;
let generation = 0;

/** Cancels even a pending permission request; acquired tracks are then stopped. */
export function cancelListening(): void {
  active?.cancel();
}

/** Start the selected provider; status callbacks cover all async failures. */
export async function startListening(
  onTranscript: (text: string) => void,
  onStatus: (status: string) => void,
): Promise<ListeningSession> {
  active?.cancel();
  const ownGeneration = ++generation;
  let canceled = false;
  let closed = false;
  let stopping = false;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let recognition: Recognition | null = null;
  const controller = new AbortController();

  function releaseMicrophone(): void {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }

  function close(message: string): void {
    if (closed) return;
    closed = true;
    if (active === session) active = null;
    controller.abort();
    if (recognition) {
      recognition.onstart = null;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      try {
        recognition.abort();
      } catch {
        message = `${message}; browser recognition could not be aborted`;
      }
    }
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          message = `${message}; recorder could not be stopped`;
        }
      }
    }
    releaseMicrophone();
    onStatus(message);
  }

  const session: ListeningSession = {
    get active() { return !closed; },
    stop() {
      if (closed || stopping) return;
      stopping = true;
      onStatus('Microphone: finishing recording');
      try {
        if (recognition) recognition.stop();
        else if (recorder && recorder.state !== 'inactive') {
          recorder.stop();
          releaseMicrophone();
        } else {
          close('Microphone stopped without a recording');
        }
      } catch {
        close('Microphone error: could not finish recording');
      }
    },
    cancel() {
      canceled = true;
      close('Microphone canceled');
    },
  };
  active = session;

  try {
    await agentState.ready;
    if (closed) return session;
    const settings = agentState.getSettings();
    if (settings.sttProvider === 'off') {
      close('Microphone disabled: select a speech recognition provider');
      return session;
    }
    if (settings.sttProvider === 'browser') {
      const host = typeof window === 'undefined' ? undefined : window as RecognitionWindow;
      const Constructor = host?.SpeechRecognition ?? host?.webkitSpeechRecognition;
      if (!Constructor) {
        throw new Error('Browser speech recognition is unavailable; select OpenAI-compatible STT');
      }
      const browserRecognition = new Constructor();
      recognition = browserRecognition;
      browserRecognition.lang = settings.speechLanguage;
      browserRecognition.continuous = false;
      browserRecognition.interimResults = false;
      const finalResults: string[] = [];
      browserRecognition.onstart = () => {
        if (!closed) onStatus('Microphone: listening (browser)');
      };
      browserRecognition.onresult = (event) => {
        if (closed) return;
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index];
          if (result?.isFinal) finalResults[index] = result[0]?.transcript ?? '';
        }
      };
      browserRecognition.onerror = (event) => {
        close(`Microphone error: browser recognition failed (${event.error})`);
      };
      browserRecognition.onend = () => {
        if (closed) return;
        const text = finalResults.join(' ').trim();
        close(text ? 'Transcription complete' : 'No speech recognized');
        // onStatus may have started a newer session during close().
        if (text && !canceled && generation === ownGeneration) onTranscript(text);
      };
      onStatus('Microphone: starting browser recognition');
      if (!closed) browserRecognition.start();
      return session;
    }

    if (!settings.sttEndpoint.trim() || !settings.sttModel.trim()) {
      throw new Error('Set the transcription endpoint and model for OpenAI-compatible STT');
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is unavailable; use a secure HTTPS context and allow microphone access');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder is unavailable in this browser');
    }
    onStatus('Microphone: requesting permission');
    if (closed) return session;
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (closed) {
      for (const track of acquired.getTracks()) track.stop();
      return session;
    }
    stream = acquired;
    const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
        .find((type) => MediaRecorder.isTypeSupported(type))
      : undefined;
    const recording = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder = recording;
    const chunks: Blob[] = [];
    recording.ondataavailable = (event) => {
      if (!closed && event.data.size) chunks.push(event.data);
    };
    recording.onerror = () => close('Microphone error: audio recording failed');
    recording.onstop = () => {
      releaseMicrophone();
      if (closed) return;
      void transcribe().catch(() => {
        if (!closed) close('Microphone error: transcription request failed (network, CORS, or invalid response)');
      });
    };

    async function transcribe(): Promise<void> {
      const type = recording.mimeType || chunks[0]?.type || 'application/octet-stream';
      const audio = new Blob(chunks, { type });
      if (!audio.size) {
        close('Microphone error: recording was empty');
        return;
      }
      const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('webm') ? 'webm' : 'bin';
      const form = new FormData();
      form.append('file', audio, `recording.${extension}`);
      form.append('model', settings.sttModel);
      const language = settings.speechLanguage.split(/[-_]/u)[0]?.toLowerCase();
      if (language && /^[a-z]{2}$/u.test(language)) form.append('language', language);
      onStatus('Microphone: transcribing');
      if (closed) return;
      const response = await fetch(`${settings.sttEndpoint.trim().replace(/\/+$/u, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: settings.sttApiKey ? { Authorization: `Bearer ${settings.sttApiKey}` } : {},
        body: form,
        signal: controller.signal,
      });
      if (closed) return;
      if (!response.ok) {
        close(`Microphone error: transcription endpoint returned HTTP ${response.status}`);
        return;
      }
      const result: unknown = await response.json();
      if (closed) return;
      if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string') {
        close('Microphone error: transcription endpoint must return a JSON text field');
        return;
      }
      const text = result.text.trim();
      close(text ? 'Transcription complete' : 'No speech recognized');
      if (text && !canceled && generation === ownGeneration) onTranscript(text);
    }

    recording.start();
    onStatus('Microphone: recording; press stop to transcribe');
    return session;
  } catch (error) {
    if (closed) return session;
    const message = error instanceof Error
      ? error.message.replaceAll(agentState.getSettings().sttApiKey || '\u0000', '[redacted]')
      : 'Microphone capture failed';
    close(`Microphone error: ${message}`);
    throw new Error(message);
  }
}

let previousSettings = agentState.getSettings();
agentState.onSettingsChanged((settings) => {
  if (settings.sttProvider !== previousSettings.sttProvider ||
      settings.sttEndpoint !== previousSettings.sttEndpoint ||
      settings.sttModel !== previousSettings.sttModel ||
      settings.sttApiKey !== previousSettings.sttApiKey ||
      settings.speechLanguage !== previousSettings.speechLanguage) active?.cancel();
  previousSettings = settings;
});
