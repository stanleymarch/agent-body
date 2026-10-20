/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, type Entity, type Object3D } from '@iwsdk/core';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  AVATAR_POSITION,
  AVATAR_URL,
  BLINK_INTERVAL_SEC,
  BLINK_PHASE_SEC,
  BREATH_AMPLITUDE,
  BREATH_RATE,
  CUE_EMOTION_ATTACK_SEC,
  CUE_EMOTION_DECAY_SEC,
  CUE_EMOTION_HOLD_SEC,
  CUE_EMOTION_WEIGHT,
  GESTURE_BOW_HEAD,
  GESTURE_BOW_SPINE,
  GESTURE_DURATIONS_SEC,
  GESTURE_NOD_AMPLITUDE,
  GESTURE_SHAKE_AMPLITUDE,
  GESTURE_THINK_HAND_RAISE,
  GESTURE_THINK_TILT,
  GESTURE_WAVE_ARM_LIFT,
  GESTURE_WAVE_HAND_SWING,
  REST_ARM_DROP,
  REST_ELBOW_BEND,
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
import type {
  AgentSettings,
  AvatarBody,
  AvatarCue,
  AvatarExpressionName,
  CueGesture,
} from './agent/contracts.js';
import { agentState } from './agent/state.js';
import { setCharacterStatus } from './agent/character.js';

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
  private readonly loader = new GLTFLoader();
  private avatarEntity: Entity | null = null;
  private requestedSource: string | null = null;
  private activeSource = '';
  private loadRevision = 0;
  private disposed = false;
  private characterScale = 1;
  private gazeTracking = true;
  private attentionTarget: Object3D | null = null;
  private chest: Object3D | null = null;
  private hips: Object3D | null = null;
  private head: Object3D | null = null;
  private spine: Object3D | null = null;
  private armR: Object3D | null = null;
  private elbowR: Object3D | null = null;
  private dirR = 1;
  private readonly headRest = { x: 0, y: 0, z: 0 };
  private readonly spineRest = { x: 0, y: 0, z: 0 };
  private readonly armRRest = { x: 0, y: 0, z: 0 };
  private readonly elbowRRest = { x: 0, y: 0, z: 0 };
  private cue: AvatarCue | null = null;
  private cueElapsed = 0;
  private cueTotal = 0;
  private cueGesture: CueGesture = 'none';
  private cueGestureDur = 0;

  init(): void {
    this.loader.register((parser) => new VRMLoaderPlugin(parser));
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
      get performing() {
        return system.cue != null;
      },
      playCue: (cue) => {
        // Replace atomically: drop the previous performance first so its
        // emotion weight and gesture bones never leak into the next cue.
        system.clearCue();
        if (cue == null) return;
        system.cue = cue;
        system.cueElapsed = 0;
        system.cueGesture = cue.gesture;
        system.cueGestureDur = GESTURE_DURATIONS_SEC[cue.gesture];
        const emotionWindow =
          CUE_EMOTION_ATTACK_SEC + CUE_EMOTION_HOLD_SEC + CUE_EMOTION_DECAY_SEC;
        system.cueTotal = Math.max(emotionWindow, system.cueGestureDur);
      },
      speakChunk: (text: string) => {
        system.hasSpokenText = true;
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          if (code < 32) continue;
          system.speakBuffer[system.speakTail] = code;
          system.speakTail = (system.speakTail + 1) % SPEAK_BUFFER_CHARS;
          if (system.speakTail === system.speakHead) {
            system.speakHead = (system.speakHead + 1) % SPEAK_BUFFER_CHARS;
          }
        }
      },
      setAttentionTarget: (target) => {
        system.attentionTarget = target;
        system.applyGaze();
      },
      setIdleMotion: (enabled) => {
        system.idleMotion = enabled;
        system.restoreIdlePose();
      },
    };
    this.cleanupFuncs.push(bindAvatarBody(this.body));
    this.cleanupFuncs.push(agentState.onSettingsChanged((settings) => {
      this.applySettings(settings);
    }));
    this.cleanupFuncs.push(() => {
      this.disposed = true;
      this.loadRevision++;
      const vrm = this.vrm;
      this.vrm = null;
      this.avatarEntity?.dispose({ disposeResources: false });
      this.avatarEntity = null;
      if (vrm != null) {
        vrm.scene.removeFromParent();
        VRMUtils.deepDispose(vrm.scene);
      }
      setCharacterStatus({ ready: false, source: '', error: '' });
    });
    this.applySettings(agentState.getSettings());
  }

  private applySettings(settings: AgentSettings): void {
    this.characterScale = settings.characterScale;
    this.idleMotion = settings.idleMotion;
    this.gazeTracking = settings.gazeTracking;
    this.attentionTarget = settings.gazeTracking ? this.world.camera : null;
    this.vrm?.scene.scale.setScalar(this.characterScale);
    this.restoreIdlePose();
    this.applyGaze();
    const source = settings.characterVrmUrl.trim() || AVATAR_URL;
    if (source !== this.requestedSource) {
      this.requestedSource = source;
      void this.replaceAvatar(source);
    }
  }

  private restoreIdlePose(): void {
    if (this.idleMotion) return;
    if (this.chest != null) this.chest.rotation.x = this.chestBaseX;
    if (this.hips != null) this.hips.rotation.z = this.hipsBaseZ;
  }

  private applyGaze(): void {
    const lookAt = this.vrm?.lookAt;
    if (lookAt == null) return;
    lookAt.target = this.gazeTracking ? this.attentionTarget : null;
    if (lookAt.target == null) lookAt.reset();
  }

  private async replaceAvatar(source: string): Promise<void> {
    const revision = ++this.loadRevision;
    setCharacterStatus({ ready: this.vrm != null, source, error: '' });
    // Returning to the visible source cancels a pending replacement without a
    // redundant download. Its callback will dispose the superseded candidate.
    if (source === this.activeSource && this.vrm != null) return;
    let candidate: VRM | null = null;
    let candidateEntity: Entity | null = null;
    try {
      const gltf = await this.loader.loadAsync(source);
      candidate = gltf.userData.vrm as VRM | undefined ?? null;
      if (candidate == null) {
        VRMUtils.deepDispose(gltf.scene);
        throw new Error('The selected file does not contain a valid VRM avatar.');
      }
      if (this.disposed || revision !== this.loadRevision) {
        VRMUtils.deepDispose(candidate.scene);
        return;
      }
      VRMUtils.rotateVRM0(candidate);
      const humanoid = candidate.humanoid;
      for (const side of ['left', 'right'] as const) {
        const arm = humanoid.getNormalizedBoneNode(`${side}UpperArm`);
        const elbow = humanoid.getNormalizedBoneNode(`${side}LowerArm`);
        if (arm == null || elbow == null) continue;
        // Normalized bones have world-aligned rest axes. Derive the sign
        // from the elbow offset so VRM 0.x and 1.0 both lower their arms.
        const direction = Math.sign(elbow.position.x);
        arm.rotation.z = -direction * REST_ARM_DROP;
        elbow.rotation.y = -direction * REST_ELBOW_BEND;
        if (side === 'right') {
          this.armR = arm;
          this.elbowR = elbow;
          this.dirR = direction;
          this.armRRest.x = arm.rotation.x;
          this.armRRest.y = arm.rotation.y;
          this.armRRest.z = arm.rotation.z;
          this.elbowRRest.x = elbow.rotation.x;
          this.elbowRRest.y = elbow.rotation.y;
          this.elbowRRest.z = elbow.rotation.z;
        }
      }
      this.head = humanoid.getNormalizedBoneNode('head');
      this.headRest.x = this.head?.rotation.x ?? 0;
      this.headRest.y = this.head?.rotation.y ?? 0;
      this.headRest.z = this.head?.rotation.z ?? 0;
      this.spine = humanoid.getNormalizedBoneNode('spine');
      this.spineRest.x = this.spine?.rotation.x ?? 0;
      this.spineRest.y = this.spine?.rotation.y ?? 0;
      this.spineRest.z = this.spine?.rotation.z ?? 0;
      this.cue = null;
      const avatar = candidate.scene;
      avatar.name = 'user-vrm';
      avatar.position.set(...AVATAR_POSITION);
      avatar.rotation.y += Math.atan2(-avatar.position.x, -avatar.position.z);
      avatar.scale.setScalar(this.characterScale);
      // Preserve authored MToon materials. They need real ambient/hemisphere
      // and direct scene lights; an environment map alone is not an input.
      candidate.lookAt?.reset();
      if (candidate.lookAt != null) {
        candidate.lookAt.target = this.gazeTracking ? this.attentionTarget : null;
      }
      candidate.update(0);
      candidateEntity = this.world.createTransformEntity(avatar);
      const previous = this.vrm;
      const previousEntity = this.avatarEntity;
      this.vrm = candidate;
      this.avatarEntity = candidateEntity;
      this.activeSource = source;
      this.chest = humanoid.getNormalizedBoneNode('chest');
      this.hips = humanoid.getNormalizedBoneNode('hips');
      this.chestBaseX = this.chest?.rotation.x ?? 0;
      this.hipsBaseZ = this.hips?.rotation.z ?? 0;
      this.blinkPhase = null;
      this.blinkTimer = BLINK_INTERVAL_SEC * 0.6;
      // Entity teardown and VRM disposal are separate: VRMUtils also handles
      // shader-uniform textures, which normal material-property disposal misses.
      previousEntity?.dispose({ disposeResources: false });
      if (previous != null) {
        previous.scene.removeFromParent();
        VRMUtils.deepDispose(previous.scene);
      }
      setCharacterStatus({ ready: true, source, error: '' });
    } catch (error) {
      // Never remove the visible avatar on a failed download/VRM preparation.
      if (candidate != null && candidate !== this.vrm) {
        candidateEntity?.dispose({ disposeResources: false });
        candidate.scene.removeFromParent();
        VRMUtils.deepDispose(candidate.scene);
      }
      if (this.disposed || revision !== this.loadRevision) return;
      this.requestedSource = null;
      const message = error instanceof Error ? error.message : String(error);
      console.error('[avatar] failed to load', source, error);
      setCharacterStatus({ ready: this.vrm != null, source, error: message });
    }
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
      if (this.chest != null) {
        this.chest.rotation.x =
          this.chestBaseX +
          BREATH_AMPLITUDE * Math.sin(this.elapsed * BREATH_RATE);
      }
      if (this.hips != null) {
        this.hips.rotation.z =
          this.hipsBaseZ + SWAY_AMPLITUDE * Math.sin(this.elapsed * SWAY_RATE);
      }
    }

    // Reply-driven cue: emotion envelope on VRM expressions plus a
    // procedural gesture layered on top of the idle pose above. Runs even
    // when idle motion is disabled, like blink and talking.
    if (this.cue != null) {
      this.cueElapsed += delta;
      if (this.cue.emotion !== 'neutral') {
        vrm.expressionManager?.setValue(
          this.cue.emotion,
          CUE_EMOTION_WEIGHT *
            this.emotionEnvelope(
              Math.min(
                this.cueElapsed,
                CUE_EMOTION_ATTACK_SEC + CUE_EMOTION_HOLD_SEC + CUE_EMOTION_DECAY_SEC,
              ),
            ),
        );
      }
      if (this.cueGestureDur > 0 && this.cueElapsed <= this.cueGestureDur) {
        this.applyGesture(this.cueGesture, this.cueElapsed / this.cueGestureDur);
      }
      if (this.cueElapsed >= this.cueTotal) {
        this.clearCue();
      }
    }


    // Advances expressions, look-at, node constraints, and spring bones.
    vrm.update(delta);
  }

  /** 0 -> 1 -> 0 trapezoid over attack/hold/decay for the cued emotion. */
  private emotionEnvelope(elapsed: number): number {
    if (elapsed < CUE_EMOTION_ATTACK_SEC) {
      return elapsed / CUE_EMOTION_ATTACK_SEC;
    }
    const holdEnd = CUE_EMOTION_ATTACK_SEC + CUE_EMOTION_HOLD_SEC;
    if (elapsed < holdEnd) return 1;
    return Math.max(
      0,
      1 - (elapsed - holdEnd) / CUE_EMOTION_DECAY_SEC,
    );
  }

  /**
   * Writes one gesture frame as absolute rotations = captured rest + offset.
   * The triangle ramp e keeps poses smooth at both ends of the gesture.
   */
  private applyGesture(name: CueGesture, t: number): void {
    const e = Math.max(0, Math.min(1, Math.min(t, 1 - t) / 0.18));
    const head = this.head;
    const armR = this.armR;
    const elbowR = this.elbowR;
    switch (name) {
      case 'nod':
        if (head != null) {
          head.rotation.x =
            this.headRest.x +
            GESTURE_NOD_AMPLITUDE * e * Math.sin(this.cueElapsed * 9);
        }
        break;
      case 'shake':
        if (head != null) {
          head.rotation.y =
            this.headRest.y +
            GESTURE_SHAKE_AMPLITUDE * e * Math.sin(this.cueElapsed * 8);
        }
        break;
      case 'think':
        if (head != null) {
          head.rotation.z = this.headRest.z + GESTURE_THINK_TILT * e;
        }
        if (armR != null) {
          armR.rotation.y = this.armRRest.y - this.dirR * 0.4 * e;
        }
        if (elbowR != null) {
          elbowR.rotation.z = this.dirR * GESTURE_THINK_HAND_RAISE * e;
        }
        break;
      case 'wave':
        if (armR != null) {
          armR.rotation.z =
            this.armRRest.z - this.dirR * GESTURE_WAVE_ARM_LIFT * e;
        }
        if (elbowR != null) {
          elbowR.rotation.z =
            this.dirR *
            (0.9 * e +
              GESTURE_WAVE_HAND_SWING * e * Math.sin(this.cueElapsed * 10));
        }
        break;
      case 'bow':
        if (this.spine != null) {
          this.spine.rotation.x = this.spineRest.x + GESTURE_BOW_SPINE * e;
        }
        if (head != null) {
          head.rotation.x = this.headRest.x + GESTURE_BOW_HEAD * e;
        }
        // Chest bows additively on top of the breathing pose above.
        if (this.chest != null) {
          this.chest.rotation.x += GESTURE_BOW_SPINE * 0.3 * e;
        }
        break;
      case 'none':
        break;
    }
  }

  /** Ends the current cue: emotion weight to zero, gesture bones to rest. */
  private clearCue(): void {
    const cue = this.cue;
    this.cue = null;
    if (cue != null && cue.emotion !== 'neutral') {
      this.vrm?.expressionManager?.setValue(cue.emotion, 0);
    }
    const head = this.head;
    if (head != null) {
      head.rotation.set(this.headRest.x, this.headRest.y, this.headRest.z);
    }
    const spine = this.spine;
    if (spine != null) {
      spine.rotation.set(this.spineRest.x, this.spineRest.y, this.spineRest.z);
    }
    const armR = this.armR;
    if (armR != null) {
      armR.rotation.set(this.armRRest.x, this.armRRest.y, this.armRRest.z);
    }
    const elbowR = this.elbowR;
    if (elbowR != null) {
      elbowR.rotation.set(
        this.elbowRRest.x,
        this.elbowRRest.y,
        this.elbowRRest.z,
      );
    }
  }
}
