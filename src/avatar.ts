/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, type Object3D } from '@iwsdk/core';
import { VRMLoaderPlugin, type VRM } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  AVATAR_URL,
  BLINK_INTERVAL_SEC,
  BLINK_PHASE_SEC,
  BREATH_AMPLITUDE,
  BREATH_RATE,
  SPEAK_BUFFER_CHARS,
  SPEAK_CHARS_PER_SEC,
  SWAY_AMPLITUDE,
  SWAY_RATE,
  TALK_AMPLITUDE,
  TALK_RATE,
  VISEME_LOW_WEIGHT,
  VISEME_SWITCH_MS,
} from './avatar-config.js';
import { bindAvatarBody } from './avatar-body.js';
import type { AvatarBody, AvatarExpressionName } from './agent/contracts.js';

/** Mouth expressions cycled by the talking oscillator, in order. */
const TALK_MOUTH: AvatarExpressionName[] = ['aa', 'ih', 'ou', 'ee'];

/** Mouth expressions zeroed when talking stops (oscillator + visemes). */
const MOUTH_EXPRESSIONS: AvatarExpressionName[] = ['aa', 'ih', 'ou', 'ee', 'oh'];

/** Maps one consumed character code to a vowel viseme, or null for closure. */
function visemeForCode(code: number): AvatarExpressionName | null {
  // ASCII vowels (and uppercase) cover streamed English-ish agent text.
  if (code === 97 || code === 65) return 'aa'; // a
  if (code === 105 || code === 73) return 'ih'; // i
  if (code === 101 || code === 69) return 'ee'; // e
  if (code === 111 || code === 79) return 'oh'; // o
  if (code === 117 || code === 85) return 'ou'; // u
  return null; // consonants, spaces, digits, punctuation: slight closure
}

/**
 * Dual-runtime user avatar: one VRM instance placed once in the shared world,
 * visible identically in browser mode and in immersive MR — XR just views the
 * same entity, nothing is forked per mode.
 *
 * Loading uses a dedicated GLTFLoader with `VRMLoaderPlugin` because VRM 1.0
 * (humanoid bones, expressions, spring bones) requires a loader plugin and
 * `AssetManager`'s internal GLTFLoader is not extensible from app code. The
 * `GLTFLoader` addon comes from `three/examples/jsm`, which resolves to the
 * same super-three instance via the project override — no duplicate Three.
 *
 * Idle life is procedural (this VRM has no embedded clips): periodic blink via
 * the expression manager plus breathing/sway offsets on normalized humanoid
 * bones. `vrm.update(delta)` advances expressions and spring bones each frame.
 *
 * Once loaded, the system binds itself to the `avatarBody` singleton
 * (`src/avatar-body.ts`) so agent code can drive expressions, talking,
 * attention, and idle motion through the shared `AvatarBody` contract.
 */
export class AvatarSystem extends createSystem({}) {
  private vrm: VRM | null = null;
  private elapsed = 0;
  private blinkTimer = BLINK_INTERVAL_SEC * 0.6;
  private blinkPhase: number | null = null;
  private chestBaseX = 0;
  private hipsBaseZ = 0;
  private talking = false;
  private talkPhase = 0;
  private talkMouth: AvatarExpressionName | null = null;
  /** Pending streamed characters (preallocated ring buffer of char codes). */
  private readonly speakBuffer = new Uint16Array(SPEAK_BUFFER_CHARS);
  private speakHead = 0;
  private speakTail = 0;
  private speakTimer = 0;
  private hasSpokenText = false;
  private curViseme: AvatarExpressionName | null = null;
  private visemeWeight = 0;
  private visemeTarget = 0;
  /** 1 / (VISEME_SWITCH_MS in seconds), for the attack/decay lerp. */
  private readonly visemeLerpRate = 1000 / VISEME_SWITCH_MS;
  private idleMotion = true;
  private body: AvatarBody | null = null;

  init(): void {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      AVATAR_URL,
      (gltf) => {
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (vrm == null) {
          console.error('[avatar] no VRM payload in', AVATAR_URL);
          return;
        }
        const chest = vrm.humanoid.getNormalizedBoneNode('chest');
        if (chest != null) {
          this.chestBaseX = chest.rotation.x;
        }
        const hips = vrm.humanoid.getNormalizedBoneNode('hips');
        if (hips != null) {
          this.hipsBaseZ = hips.rotation.z;
        }
        this.vrm = vrm;
        const system = this;
        this.body = {
          get available() {
            return system.vrm != null;
          },
          setExpression: (name, weight) => {
            system.vrm?.expressionManager?.setValue(
              name,
              Math.min(1, Math.max(0, weight)),
            );
          },
          setTalking: (active) => {
            system.talking = active;
            system.talkPhase = 0;
            system.talkMouth = null;
            system.hasSpokenText = false;
            system.speakHead = 0;
            system.speakTail = 0;
            system.speakTimer = 0;
            system.curViseme = null;
            system.visemeWeight = 0;
            system.visemeTarget = 0;
            if (!active) {
              const expressions = system.vrm?.expressionManager;
              if (expressions != null) {
                for (const mouth of MOUTH_EXPRESSIONS) {
                  expressions.setValue(mouth, 0);
                }
              }
            }
          },
          speakChunk: (text: string) => {
            system.hasSpokenText = true;
            for (let i = 0; i < text.length; i++) {
              const code = text.charCodeAt(i);
              if (code < 32) {
                continue; // control characters: not speech
              }
              system.speakBuffer[system.speakTail] = code;
              system.speakTail = (system.speakTail + 1) % SPEAK_BUFFER_CHARS;
              if (system.speakTail === system.speakHead) {
                // Buffer full: drop the oldest character.
                system.speakHead = (system.speakHead + 1) % SPEAK_BUFFER_CHARS;
              }
            }
          },
          setAttentionTarget: (target) => {
            const lookAt = system.vrm?.lookAt;
            if (lookAt != null) {
              lookAt.target = target;
            }
          },
          setIdleMotion: (enabled) => {
            system.idleMotion = enabled;
          },
        };
        bindAvatarBody(this.body);
        const entity = this.world.createTransformEntity(vrm.scene);
        const avatar = entity.object3D!;
        avatar.name = 'user-vrm';
        avatar.position.set(0.9, 0, -1.4);
        // VRM 1.0 models face +Z; yaw so the avatar looks at the player origin.
        avatar.rotation.y = Math.atan2(-avatar.position.x, -avatar.position.z);
        console.log('[avatar] user-vrm ready (VRM 1.0, idle: blink/breath/sway)');
      },
      undefined,
      (error) => {
        console.error('[avatar] failed to load', AVATAR_URL, error);
      },
    );
  }

  update(delta: number): void {
    const vrm = this.vrm;
    if (vrm == null) {
      return;
    }
    this.elapsed += delta;

    // Blink: wait, then run one 0→1→0 pulse over BLINK_PHASE_SEC.
    if (this.blinkPhase == null) {
      this.blinkTimer -= delta;
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 0;
        this.blinkTimer = BLINK_INTERVAL_SEC;
      }
    } else {
      this.blinkPhase += delta;
      const t = this.blinkPhase / BLINK_PHASE_SEC;
      if (t >= 1) {
        this.blinkPhase = null;
        vrm.expressionManager?.setValue('blink', 0);
      } else {
        vrm.expressionManager?.setValue('blink', 1 - Math.abs(1 - 2 * t));
      }
    }

    // Talking: text-driven visemes when `speakChunk` has fed characters,
    // otherwise the legacy phase-based mouth oscillator. No allocations.
    if (this.talking) {
      if (this.hasSpokenText) {
        const expressions = vrm.expressionManager;
        if (expressions != null) {
          // Consume buffered characters at a fixed chars/sec rate.
          const perChar = 1 / SPEAK_CHARS_PER_SEC;
          this.speakTimer += delta;
          while (this.speakTimer >= perChar && this.speakHead !== this.speakTail) {
            this.speakTimer -= perChar;
            const code = this.speakBuffer[this.speakHead];
            this.speakHead = (this.speakHead + 1) % SPEAK_BUFFER_CHARS;
            const next = visemeForCode(code);
            if (next != null) {
              if (next !== this.curViseme) {
                // Zero the previous viseme only on a switch.
                if (this.curViseme != null) {
                  expressions.setValue(this.curViseme, 0);
                }
                this.curViseme = next;
              }
              this.visemeTarget = TALK_AMPLITUDE;
            } else {
              // Consonant/space run: hold the last shape at low weight so
              // the mouth is not frozen open.
              this.visemeTarget = VISEME_LOW_WEIGHT;
            }
          }
          // Buffer drained while still talking: ease fully closed.
          if (this.speakHead === this.speakTail) {
            this.visemeTarget = 0;
          }
          // ~60 ms attack/decay envelope toward the target weight.
          const k = Math.min(1, delta * this.visemeLerpRate);
          this.visemeWeight += (this.visemeTarget - this.visemeWeight) * k;
          if (this.curViseme != null) {
            expressions.setValue(this.curViseme, this.visemeWeight);
          }
        }
      } else {
        this.talkPhase += delta * TALK_RATE;
        const segment = Math.floor(this.talkPhase / (Math.PI / 2));
        const mouth = TALK_MOUTH[segment % TALK_MOUTH.length];
        const expressions = vrm.expressionManager;
        if (expressions != null) {
          if (mouth !== this.talkMouth) {
            if (this.talkMouth != null) {
              expressions.setValue(this.talkMouth, 0);
            }
            this.talkMouth = mouth;
          }
          const envelope = Math.sin(this.talkPhase);
          expressions.setValue(mouth, TALK_AMPLITUDE * (0.5 + 0.5 * envelope));
        }
      }
    }

    // Breathing and sway as offsets from the captured rest pose. Frozen at the
    // rest pose when idle motion is disabled (blink and talking stay live).
    if (this.idleMotion) {
      const chest = vrm.humanoid.getNormalizedBoneNode('chest');
      if (chest != null) {
        chest.rotation.x =
          this.chestBaseX +
          BREATH_AMPLITUDE * Math.sin(this.elapsed * BREATH_RATE);
      }
      const hips = vrm.humanoid.getNormalizedBoneNode('hips');
      if (hips != null) {
        hips.rotation.z =
          this.hipsBaseZ + SWAY_AMPLITUDE * Math.sin(this.elapsed * SWAY_RATE);
      }
    }

    // Advances expressions, look-at, node constraints, and spring bones.
    vrm.update(delta);
  }
}
