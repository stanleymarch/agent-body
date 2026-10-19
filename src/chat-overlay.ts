/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root source tree.
 */

import { VisibilityState, type World } from '@iwsdk/core';
import { agentBrain } from './agent/brain.js';
import { agentState } from './agent/state.js';
import type { AgentSettings } from './agent/contracts.js';

/**
 * Browser-mode (NonImmersive) chat bar wired to the agent brain.
 * Hidden during any immersive session. Returns an unmount function.
 */
export function mountChatOverlay(world: World): () => void {
  const style = document.createElement('style');
  style.textContent = `
    #agent-chat-overlay {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: min(560px, 80vw);
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(20, 22, 28, 0.72);
      color: #e8eaf0;
      font: 13px/1.4 system-ui, sans-serif;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
      z-index: 1000;
      box-sizing: border-box;
    }
    #agent-chat-overlay[hidden] { display: none; }
    #agent-chat-overlay .agent-chat-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    #agent-chat-overlay input {
      flex: 1;
      min-width: 0;
      padding: 8px 10px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.06);
      color: inherit;
      font: inherit;
      outline: none;
    }
    #agent-chat-overlay input:focus { border-color: rgba(120, 160, 255, 0.7); }
    #agent-chat-overlay input:disabled { opacity: 0.5; }
    #agent-chat-overlay button {
      padding: 8px 14px;
      border: none;
      border-radius: 8px;
      background: #3b62d4;
      color: #fff;
      font: inherit;
      cursor: pointer;
    }
    #agent-chat-overlay button:disabled { opacity: 0.5; cursor: default; }
    #agent-chat-overlay .agent-chat-status {
      font-size: 11px;
      opacity: 0.6;
    }
    #agent-chat-overlay .agent-chat-reply {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-height: 18px;
      font-size: 12px;
      opacity: 0.9;
    }
  `;
  document.head.append(style);

  const root = document.createElement('div');
  root.id = 'agent-chat-overlay';

  const row = document.createElement('div');
  row.className = 'agent-chat-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Talk to Ava…';
  // Keep WASD locomotion from also firing while typing.
  input.addEventListener('keydown', (e) => e.stopPropagation());

  const send = document.createElement('button');
  send.type = 'button';
  send.textContent = 'Send';

  const status = document.createElement('span');
  status.className = 'agent-chat-status';
  status.role = 'status';
  status.ariaLive = 'polite';

  const reply = document.createElement('div');
  reply.className = 'agent-chat-reply';
  reply.role = 'log';
  reply.ariaLive = 'polite';

  row.append(input, send);
  root.append(row, status, reply);
  document.body.append(root);

  const setBusy = (busy: boolean): void => {
    input.disabled = busy;
    send.disabled = busy;
  };

  const submit = (): void => {
    const text = input.value.trim();
    if (!text || agentBrain.busy) return;
    input.value = '';
    setBusy(true);
    agentBrain
      .send(text)
      .then((r) => {
        reply.textContent = r;
      })
      .catch((err: unknown) => {
        reply.textContent = String(err);
      })
      .finally(() => setBusy(false));
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  send.addEventListener('click', submit);

  const renderStatus = (settings: AgentSettings): void => {
    let host = '';
    if (settings.modelEndpoint) {
      try {
        host = new URL(settings.modelEndpoint).host;
      } catch {
        host = settings.modelEndpoint;
      }
    }
    status.textContent =
      agentBrain.mode === 'live' && settings.modelId && host
        ? `${settings.modelId}@${host}`
        : 'offline brain';
  };

  const onSettingsChanged = agentState.onSettingsChanged(renderStatus);
  renderStatus(agentState.getSettings());

  const onVisibility = (state: VisibilityState): void => {
    const visible = state === VisibilityState.NonImmersive;
    root.hidden = !visible;
    if (!visible && document.activeElement === input) input.blur();
  };
  const unsubscribeVisibility = world.visibilityState.subscribe(onVisibility);
  onVisibility(world.visibilityState.value);

  return () => {
    unsubscribeVisibility();
    onSettingsChanged();
    root.remove();
    style.remove();
  };
}
