/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { BrowserMouseLookSystem } from './mouselook.js';
import { AvatarSystem } from './avatar.js';
import { AmbientSystem } from './ambient.js';
import { consumePairingUrl, createPairingOffer } from './pairing.js';
import { agentState } from './agent/state.js';
import { agentBrain } from './agent/brain.js';
import { avatarBody } from './avatar-body.js';
import { WorkspaceSystem } from './workspace.js';
import { bindPerception } from './agent/perception.js';

// The workspace palette is light and the custom text colors assume a light
// surface. The color scheme is pinned in iwsdk.config.json
// (world.features.spatialUI.preferredColorScheme) so a dark OS/browser scheme
// cannot paint dark text on a dark panel.

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(BrowserMouseLookSystem);
  world.registerSystem(AvatarSystem);
  world.registerSystem(AmbientSystem);
  world.addCleanup(bindPerception(world));
  world.registerSystem(WorkspaceSystem);

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__agentBody = {
      world,
      agentState,
      agentBrain,
      avatarBody,
      pairing: { createPairingOffer, consumePairingUrl },
    };
  }
});
