/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { Object3D } from '@iwsdk/core';
import type { AvatarBody, AvatarExpressionName } from './agent/contracts.js';

/**
 * Live driver bound by `AvatarSystem` once the VRM is loaded. `null` before
 * load (and across HMR reloads until the new system rebinds), which makes the
 * exported `avatarBody` singleton a safe no-op facade for early consumers.
 */
let impl: AvatarBody | null = null;

/**
 * Called exactly once per AvatarSystem lifetime by `src/avatar.ts` when the
 * VRM scene graph exists and expressions can be driven.
 */
export function bindAvatarBody(body: AvatarBody): void {
  impl = body;
}

/**
 * Singleton facade implementing {@link AvatarBody} from the agent contracts.
 * Every method is a no-op and `available === false` until the avatar system
 * binds a live impl via {@link bindAvatarBody}.
 */
export const avatarBody: AvatarBody = {
  get available(): boolean {
    return impl != null;
  },
  setExpression(name: AvatarExpressionName, weight: number): void {
    impl?.setExpression(name, weight);
  },
  setTalking(active: boolean): void {
    impl?.setTalking(active);
  },
  speakChunk(text: string): void {
    impl?.speakChunk(text);
  },
  setAttentionTarget(target: Object3D | null): void {
    impl?.setAttentionTarget(target);
  },
  setIdleMotion(enabled: boolean): void {
    impl?.setIdleMotion(enabled);
  },
};
