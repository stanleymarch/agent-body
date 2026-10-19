/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Best-effort speech output via the Web Speech API. Gracefully no-ops where
 * `speechSynthesis` is missing or has no voices (e.g. headless Chromium), so
 * the same code path ships to desktop and Quest — on-device availability is
 * probed at call time, never assumed.
 */
const enabled = typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Speak text; resolves immediately when synthesis is unavailable. */
export function speak(text: string): void {
  if (!enabled || text.length === 0) {
    return;
  }
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Voice list races and cross-frame usage can throw; stay silent.
  }
}

/** Stop any pending speech (e.g. when a new reply starts). */
export function hush(): void {
  if (!enabled) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
  } catch {
    // ignore
  }
}
