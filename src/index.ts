/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './panel.js';
import { RobotSystem } from './robot.js';
import { BrowserMouseLookSystem } from './mouselook.js';
import { AvatarSystem } from './avatar.js';
import { AgentPanelSystem } from './agent-ui.js';
import { AmbientSystem } from './ambient.js';
import { mountChatOverlay } from './chat-overlay.js';
import { mountSettingsEditor } from './settings-editor.js';
import { mountPairingReceiver } from './pairing-receiver.js';
import { consumePairingUrl, createPairingOffer } from './pairing.js';
import { agentState } from './agent/state.js';
import { agentBrain } from './agent/brain.js';
import { avatarBody } from './avatar-body.js';

// Finish a scanned settings-pairing link before any XR session starts.
mountPairingReceiver();
World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(RobotSystem);
  world.registerSystem(PanelSystem);
  world.registerSystem(BrowserMouseLookSystem);
  world.registerSystem(AvatarSystem);
  world.registerSystem(AgentPanelSystem);
  world.registerSystem(AmbientSystem);
  mountChatOverlay(world);
  mountSettingsEditor(world);

  // Dev bootstrap: configure a live OpenAI-compatible endpoint without
  // bundling credentials into source.
  const env = import.meta.env;
  const endpoint =
    typeof env.VITE_AGENT_ENDPOINT === 'string'
      ? env.VITE_AGENT_ENDPOINT
      : '';
  if (endpoint === 'scripted') {
    void agentState.updateSettings({
      modelEndpoint: '',
      modelId: '',
      modelApiKey: '',
    });
  } else if (endpoint.length > 0) {
    void agentState.updateSettings({
      modelEndpoint: endpoint,
      modelId:
        typeof env.VITE_AGENT_MODEL === 'string' ? env.VITE_AGENT_MODEL : '',
      modelApiKey:
        typeof env.VITE_AGENT_KEY === 'string' ? env.VITE_AGENT_KEY : '',
    });
  }

  // Runtime inspection hook for the managed-browser tooling (read-only use).
  (window as unknown as Record<string, unknown>).__agentBody = {
    agentState,
    agentBrain,
    avatarBody,
    pairing: { createPairingOffer, consumePairingUrl },
  };
});
