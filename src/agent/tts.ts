/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { agentState } from './state.js';

let status = 'Speech disabled';
const listeners = new Set<(status: string) => void>();
let active: { cancel(): void } | null = null;

function notify(value: string): void {
  status = value;
  for (const listener of listeners) listener(value);
}

export function getSpeechStatus(): string {
  return status;
}

/** Subscribe to loading, playback, cancellation, and errors; also report now. */
export function onSpeechStatus(callback: (status: string) => void): () => void {
  listeners.add(callback);
  callback(status);
  return () => { listeners.delete(callback); };
}

/** Cancel fetching or playback. Intentional cancellation resolves speak(). */
export function hush(): void {
  active?.cancel();
}

/** Speak using the selected provider. Failures are both reported and rejected. */
export function speak(text: string): Promise<void> {
  hush();
  if (!text.trim()) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    const cleanups: (() => void)[] = [];
    let finished = false;
    const operation = { cancel: () => finish('Speech canceled') };
    active = operation;

    function finish(message: string, error?: Error): void {
      if (finished) return;
      finished = true;
      if (active === operation) active = null;
      controller.abort();
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {
          error ??= new Error('Speech playback cleanup failed');
        }
      }
      notify(error ? `Speech error: ${error.message}` : message);
      if (error) reject(error);
      else resolve();
    }

    async function run(): Promise<void> {
      await agentState.ready;
      if (finished) return;
      const settings = agentState.getSettings();
      if (settings.ttsProvider === 'off') {
        finish('Speech disabled');
        return;
      }
      if (settings.ttsProvider === 'browser') {
        if (typeof window === 'undefined' || !window.speechSynthesis ||
            typeof SpeechSynthesisUtterance === 'undefined') {
          throw new Error('Browser speech synthesis is unavailable; select another provider');
        }
        const synthesis = window.speechSynthesis;
        let voices = synthesis.getVoices();
        if (!voices.length) {
          notify('Speech: loading browser voices');
          if (finished) return;
          await new Promise<void>((done) => {
            const complete = () => {
              clearTimeout(timer);
              synthesis.removeEventListener('voiceschanged', complete);
              done();
            };
            const timer = setTimeout(complete, 1500);
            synthesis.addEventListener('voiceschanged', complete);
            cleanups.push(complete);
          });
          if (finished) return;
          voices = synthesis.getVoices();
        }
        if (!voices.length) throw new Error('No browser speech voices are available');
        const selected = settings.ttsVoice.trim();
        const voice = selected
          ? voices.find((item) => item.voiceURI === selected || item.name === selected)
          : voices.find((item) => item.lang.toLowerCase() === settings.speechLanguage.toLowerCase()) ??
            voices.find((item) => item.lang.split('-')[0]?.toLowerCase() === settings.speechLanguage.split('-')[0]?.toLowerCase()) ??
            voices.find((item) => item.default) ?? voices[0];
        if (!voice) throw new Error('Selected browser voice is unavailable; select an installed voice or leave voice empty');
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = voice;
        utterance.lang = settings.speechLanguage;
        utterance.rate = 1.05;
        utterance.onstart = () => { if (!finished) notify('Speech: speaking (browser)'); };
        utterance.onend = () => finish('Speech complete');
        utterance.onerror = (event) => finish('', new Error(`Browser synthesis failed (${event.error})`));
        cleanups.push(() => {
          utterance.onstart = null;
          utterance.onend = null;
          utterance.onerror = null;
          synthesis.cancel();
        });
        notify('Speech: queued (browser)');
        if (!finished) synthesis.speak(utterance);
        return;
      }

      if (!settings.ttsEndpoint.trim() || !settings.ttsModel.trim() || !settings.ttsVoice.trim()) {
        throw new Error('Set the speech endpoint, model, and voice for OpenAI-compatible TTS');
      }
      if (typeof Audio === 'undefined') throw new Error('Audio playback is unavailable');
      notify('Speech: generating audio');
      if (finished) return;
      const response = await fetch(`${settings.ttsEndpoint.trim().replace(/\/+$/u, '')}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.ttsApiKey ? { Authorization: `Bearer ${settings.ttsApiKey}` } : {}),
        },
        body: JSON.stringify({ model: settings.ttsModel, voice: settings.ttsVoice, input: text }),
        signal: controller.signal,
      });
      if (finished) return;
      if (!response.ok) throw new Error(`Speech endpoint returned HTTP ${response.status}`);
      const blob = await response.blob();
      if (finished) return;
      if (!blob.size) throw new Error('Speech endpoint returned empty audio');
      const url = URL.createObjectURL(blob);
      cleanups.push(() => URL.revokeObjectURL(url));
      const audio = new Audio(url);
      cleanups.push(() => {
        audio.onended = null;
        audio.onerror = null;
        audio.onplaying = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      });
      audio.onended = () => finish('Speech complete');
      audio.onerror = () => finish('', new Error('Generated speech audio could not be decoded or played'));
      audio.onplaying = () => { if (!finished) notify('Speech: speaking (OpenAI-compatible)'); };
      notify('Speech: starting audio');
      if (!finished) await audio.play();
    }

    void run().catch((error: unknown) => {
      if (!finished) {
        // Never expose response bodies or request objects: providers may echo keys.
        const message = error instanceof Error && !controller.signal.aborted
          ? error.message.replaceAll(agentState.getSettings().ttsApiKey || '\u0000', '[redacted]')
          : 'Speech request failed';
        finish('', new Error(message));
      }
    });
  });
}

let previousSettings = agentState.getSettings();
agentState.onSettingsChanged((settings) => {
  if (settings.ttsProvider !== previousSettings.ttsProvider ||
      settings.ttsEndpoint !== previousSettings.ttsEndpoint ||
      settings.ttsModel !== previousSettings.ttsModel ||
      settings.ttsVoice !== previousSettings.ttsVoice ||
      settings.ttsApiKey !== previousSettings.ttsApiKey ||
      settings.speechLanguage !== previousSettings.speechLanguage) {
    hush();
    notify(settings.ttsProvider === 'off' ? 'Speech disabled' : `Speech ready (${settings.ttsProvider})`);
  }
  previousSettings = settings;
});
