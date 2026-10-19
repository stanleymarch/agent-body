/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** User avatar file (VRM 1.0, VRoid). Served from public/. */
export const AVATAR_URL = `${import.meta.env.BASE_URL}vrm/user.vrm`.replace(
  /\/+/gu,
  '/',
);

/** Seconds between blink pulses (plus the blink itself). */
export const BLINK_INTERVAL_SEC = 3.7;
/** One blink pulse duration (close → open). */
export const BLINK_PHASE_SEC = 0.16;
/** Chest rotation amplitude for breathing, radians. */
export const BREATH_AMPLITUDE = 0.022;
/** Breathing angular rate, rad/s (~4.1 s cycle). */
export const BREATH_RATE = 1.5;
/** Hips roll amplitude for idle sway, radians. */
export const SWAY_AMPLITUDE = 0.008;
/** Idle sway angular rate, rad/s. */
export const SWAY_RATE = 0.6;

/** Peak mouth-open weight for the talking oscillator (0..1). */
export const TALK_AMPLITUDE = 0.35;
/** Talking mouth cycle angular rate, rad/s. */
export const TALK_RATE = 9;

// --- Text-driven visemes (speakChunk) ---
/** Streamed-text consumption rate for text-driven visemes, chars/sec. */
export const SPEAK_CHARS_PER_SEC = 14;
/** Viseme weight attack/decay time constant, milliseconds. */
export const VISEME_SWITCH_MS = 60;
/** Eased rest weight for consonant/space runs so the mouth is not frozen open. */
export const VISEME_LOW_WEIGHT = 0.15;
/** Pending-character ring buffer capacity for `speakChunk` text. */
export const SPEAK_BUFFER_CHARS = 256;

/** Minimum idle seconds between ambient expression pulses. */
export const AMBIENT_MIN_INTERVAL_SEC = 12;
/** Maximum idle seconds between ambient expression pulses. */
export const AMBIENT_MAX_INTERVAL_SEC = 30;
/** Duration of one ambient expression pulse. */
export const AMBIENT_PULSE_SEC = 1.2;
/** Peak weight of an ambient expression pulse (kept subtle). */
export const AMBIENT_MAX_WEIGHT = 0.25;
