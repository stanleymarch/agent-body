/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { AvatarCue, CueEmotion, CueGesture } from './contracts.js';

/**
 * Reply performance cues: how emotion + gesture travel with a reply.
 *
 * The model (or the offline brain) prefixes its reply with exactly one tag:
 * `[[happy|wave]] Hello! ...`. `CueStreamFilter` strips that tag from the
 * streamed text so chat display, speech synthesis, and visemes only ever see
 * clean text — and exposes the parsed cue the moment the tag completes, even
 * when the tag is split across stream chunks.
 *
 * The cue then fans out to: `avatarBody.playCue` (expression + gesture),
 * `publishAvatarCue` (workspace badge), and nothing else. Memory persistence
 * and TTS receive only the filtered text.
 */

export const CUE_EMOTIONS: readonly CueEmotion[] = [
  'neutral',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
];

export const CUE_GESTURES: readonly CueGesture[] = [
  'none',
  'wave',
  'nod',
  'shake',
  'think',
  'bow',
];

const TAG_SUFFIX = ']]';
/** Beyond this length a leading '[' is treated as plain text, not a tag. */
const TAG_MAX_CHARS = 48;
const TAG_RE = /^\s*\[\[\s*([A-Za-z]+)\s*\|\s*([A-Za-z]+)\s*\]\]/u;

/** Renders a cue as the leading tag the model is instructed to emit. */
export function buildCueTag(cue: AvatarCue): string {
  return `[[${cue.emotion}|${cue.gesture}]]`;
}

/**
 * Incremental tag stripper for token streams. Holds back only the leading
 * characters that may still turn into a tag; once decided, every later chunk
 * passes through untouched.
 */
export class CueStreamFilter {
  private buffer = '';
  private decided = false;
  private emitted = '';
  /** Parsed cue, set as soon as the leading tag completes (else null). */
  cue: AvatarCue | null = null;

  /** Feed one stream chunk; returns the text that is safe to show/speak. */
  push(chunk: string): string {
    if (this.decided) {
      this.emitted += chunk;
      return chunk;
    }
    this.buffer += chunk;
    const trimmed = this.buffer.trimStart();
    if (trimmed.length === 0) return '';
    if (trimmed.charAt(0) !== '[') return this.release();
    if (trimmed.length >= 2 && trimmed.charAt(1) !== '[') return this.release();
    const close = trimmed.indexOf(TAG_SUFFIX);
    if (close === -1) {
      return trimmed.length > TAG_MAX_CHARS ? this.release() : '';
    }
    const head = trimmed.slice(0, close + TAG_SUFFIX.length);
    const match = TAG_RE.exec(head);
    if (match != null) {
      const emotion = match[1]!.toLowerCase() as CueEmotion;
      const gesture = match[2]!.toLowerCase() as CueGesture;
      this.cue = {
        emotion: CUE_EMOTIONS.includes(emotion) ? emotion : 'neutral',
        gesture: CUE_GESTURES.includes(gesture) ? gesture : 'none',
      };
    }
    const rest = trimmed.slice(close + TAG_SUFFIX.length);
    this.buffer = '';
    this.decided = true;
    this.emitted += rest;
    return rest;
  }

  /** Flush any held-back text at end of stream (incomplete tags pass). */
  end(): string {
    if (this.decided) return '';
    return this.release();
  }

  /** All clean text emitted so far. */
  get text(): string {
    return this.emitted;
  }

  private release(): string {
    const rest = this.buffer;
    this.buffer = '';
    this.decided = true;
    this.emitted += rest;
    return rest;
  }
}

// ---------------------------------------------------------------------------
// Offline cue selection (scripted brain): keyword rules so the demo performs
// without a configured model endpoint.
// ---------------------------------------------------------------------------

interface OfflineRule {
  readonly test: RegExp;
  readonly cue: AvatarCue;
}

const OFFLINE_RULES: readonly OfflineRule[] = [
  {
    test: /\b(hi|hello|hey)\b|привет|здравств|хай/ui,
    cue: { emotion: 'happy', gesture: 'wave' },
  },
  {
    test: /thank|спасиб/ui,
    cue: { emotion: 'happy', gesture: 'nod' },
  },
  { test: /\?/u, cue: { emotion: 'surprised', gesture: 'nod' } },
  {
    test: /sad|груст|плохо|устал|unfortunate|больно/ui,
    cue: { emotion: 'sad', gesture: 'none' },
  },
  {
    test: /\b(no|nope)\b|\bнет\b|не хочу/ui,
    cue: { emotion: 'relaxed', gesture: 'shake' },
  },
  {
    test: /joke|funny|шутк|смешн/ui,
    cue: { emotion: 'happy', gesture: 'think' },
  },
  {
    test: /\b(bye|goodbye)\b|пока|до свидан/ui,
    cue: { emotion: 'relaxed', gesture: 'bow' },
  },
  {
    test: /remember|запомн|заметк|\bnote\b/ui,
    cue: { emotion: 'relaxed', gesture: 'think' },
  },
];

const DEFAULT_CUE: AvatarCue = { emotion: 'happy', gesture: 'nod' };

/** Picks a demo cue from the user text; first matching rule wins. */
export function pickOfflineCue(text: string): AvatarCue {
  for (const rule of OFFLINE_RULES) {
    if (rule.test.test(text)) return rule.cue;
  }
  return DEFAULT_CUE;
}

// ---------------------------------------------------------------------------
// Cue change notifications for presentation layers (desktop + spatial).
// ---------------------------------------------------------------------------

type CueListener = (cue: AvatarCue | null) => void;

const cueListeners = new Set<CueListener>();
let activeCue: AvatarCue | null = null;

export function onAvatarCue(listener: CueListener): () => void {
  cueListeners.add(listener);
  return () => {
    cueListeners.delete(listener);
  };
}

export function publishAvatarCue(cue: AvatarCue | null): void {
  activeCue = cue;
  for (const listener of cueListeners) listener(cue);
}

export function getAvatarCue(): AvatarCue | null {
  return activeCue;
}
