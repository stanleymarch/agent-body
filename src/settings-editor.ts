/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { VisibilityState, type World } from '@iwsdk/core';
import { agentState } from './agent/state.js';
import type { AgentSettings } from './agent/contracts.js';

import qrcode from 'qrcode-generator';
import { createPairingOffer, type PairingOffer } from './pairing.js';

export type EditableAgentSetting =
  | 'modelEndpoint'
  | 'modelId'
  | 'modelApiKey';
export type SettingsEditResult = 'desktop' | 'immersive' | 'unavailable';

type KeyboardAwareSession = XRSession & {
  readonly isSystemKeyboardSupported?: boolean;
};

type ActiveSettingsEditor = {
  edit(field: EditableAgentSetting): SettingsEditResult;
};

let activeEditor: ActiveSettingsEditor | null = null;

/** Open one setting from spatial UIKit or desktop UI. */
export function editAgentSetting(
  field: EditableAgentSetting,
): SettingsEditResult {
  return activeEditor?.edit(field) ?? 'unavailable';
}

/**
 * Mounts normal browser settings plus one in-viewport DOM input used by the
 * Quest WebXR system keyboard. Both write the same IndexedDB-backed state.
 */
export function mountSettingsEditor(world: World): () => void {
  const style = document.createElement('style');
  style.textContent = `
    #agent-settings-launcher {
      position: fixed; right: 20px; bottom: 20px; z-index: 20;
      min-height: 44px; padding: 0 18px; border: 1px solid #41506f;
      border-radius: 22px; color: #f5f7ff; background: #18213a;
      font: 600 14px/1 system-ui, sans-serif; cursor: pointer;
    }
    #agent-settings-card {
      position: fixed; right: 20px; bottom: 76px; z-index: 20;
      width: min(420px, calc(100vw - 40px)); box-sizing: border-box;
      max-height: calc(100vh - 96px); overflow-y: auto;
      padding: 18px; border: 1px solid #41506f; border-radius: 16px;
      color: #f5f7ff; background: rgba(16, 24, 45, 0.97);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.42);
      font: 14px/1.35 system-ui, sans-serif;
    }
    #agent-settings-card[hidden], #agent-settings-launcher[hidden] {
      display: none;
    }
    #agent-settings-card h2 { margin: 0 0 6px; font-size: 19px; }
    #agent-settings-card p { margin: 0 0 14px; color: #b8c1d9; }
    #agent-settings-card label { display: block; margin-top: 10px; }
    #agent-settings-card input {
      width: 100%; box-sizing: border-box; margin-top: 5px; padding: 10px 12px;
      border: 1px solid #536483; border-radius: 9px; color: #f8faff;
      background: #0e1528; font: 14px/1.2 ui-monospace, monospace;
    }
    .agent-settings-actions { display: flex; gap: 8px; margin-top: 16px; }
    .agent-settings-actions button {
      min-height: 42px; padding: 0 14px; border: 0; border-radius: 10px;
      color: #fff; background: #294b93; font-weight: 700; cursor: pointer;
    }
    .agent-settings-actions button.secondary { background: #303a50; }
    #agent-settings-share { margin-top: 16px; text-align: center; }
    #agent-settings-share[hidden] { display: none; }
    #agent-settings-share img {
      width: 240px; height: 240px; image-rendering: pixelated;
      border: 8px solid #f5f7ff; border-radius: 8px; background: #fff;
    }
    #agent-settings-share .pin {
      margin-top: 10px; font: 700 24px/1 ui-monospace, monospace;
      letter-spacing: 8px;
    }
    #agent-settings-share .hint { margin-top: 6px; color: #b8c1d9; }
    #agent-settings-share .ttl { margin-top: 4px; color: #8b96b4; }
  `;
  document.head.append(style);

  const launcher = document.createElement('button');
  launcher.id = 'agent-settings-launcher';
  launcher.type = 'button';
  launcher.textContent = 'Model settings';

  const card = document.createElement('section');
  card.id = 'agent-settings-card';
  card.hidden = true;
  card.innerHTML = `
    <h2>Model settings</h2>
    <p>Stored only in this browser. Use a user-owned endpoint and key.</p>
    <label>OpenAI-compatible endpoint
      <input id="agent-setting-endpoint" type="url" inputmode="url" autocomplete="off" placeholder="https://host.example/v1">
    </label>
    <label>Model ID
      <input id="agent-setting-model" type="text" autocomplete="off" placeholder="model-id">
    </label>
    <label>API key
      <input id="agent-setting-key" type="password" autocomplete="off" placeholder="Not set">
    </label>
    <div class="agent-settings-actions">
      <button id="agent-settings-save" type="button">Save locally</button>
      <button id="agent-settings-share-btn" type="button">Share to headset</button>
      <button id="agent-settings-clear-key" class="secondary" type="button">Clear key</button>
      <button id="agent-settings-close" class="secondary" type="button">Close</button>
    </div>
    <div id="agent-settings-share" hidden>
      <img id="agent-settings-qr" alt="Settings pairing QR code">
      <div class="pin" id="agent-settings-pin"></div>
      <div class="hint">
        Scan with a headset QR app, then enter this PIN on the opened page.
      </div>
      <div class="ttl" id="agent-settings-ttl"></div>
      <div class="agent-settings-actions" style="justify-content:center">
        <button id="agent-settings-copy" class="secondary" type="button">Copy link</button>
        <button id="agent-settings-stop" class="secondary" type="button">Stop sharing</button>
      </div>
    </div>
    <div id="agent-settings-status" role="status" aria-live="polite"></div>
  `;

  const endpoint = card.querySelector<HTMLInputElement>('#agent-setting-endpoint')!;
  const model = card.querySelector<HTMLInputElement>('#agent-setting-model')!;
  const key = card.querySelector<HTMLInputElement>('#agent-setting-key')!;
  const save = card.querySelector<HTMLButtonElement>('#agent-settings-save')!;
  const clearKey = card.querySelector<HTMLButtonElement>('#agent-settings-clear-key')!;
  const close = card.querySelector<HTMLButtonElement>('#agent-settings-close')!;
  const shareBtn =
    card.querySelector<HTMLButtonElement>('#agent-settings-share-btn')!;
  const shareBox = card.querySelector<HTMLDivElement>('#agent-settings-share')!;
  const qrImg = card.querySelector<HTMLImageElement>('#agent-settings-qr')!;
  const pinText = card.querySelector<HTMLDivElement>('#agent-settings-pin')!;
  const ttlText = card.querySelector<HTMLDivElement>('#agent-settings-ttl')!;
  const copyLink = card.querySelector<HTMLButtonElement>('#agent-settings-copy')!;
  const stopShare = card.querySelector<HTMLButtonElement>('#agent-settings-stop')!;
  const status = card.querySelector<HTMLDivElement>('#agent-settings-status')!;
  const inputs: Record<EditableAgentSetting, HTMLInputElement> = {
    modelEndpoint: endpoint,
    modelId: model,
    modelApiKey: key,
  };

  // Must remain inside the viewport and attached to DOM in immersive mode.
  // Meta Quest Browser focuses this element to show its system keyboard.
  const keyboardInput = document.createElement('input');
  keyboardInput.id = 'agent-xr-keyboard-input';
  keyboardInput.autocomplete = 'off';
  keyboardInput.style.cssText =
    'position:fixed;left:1px;bottom:1px;width:1px;height:1px;padding:0;border:0;outline:0;opacity:0.01;color:transparent;background:transparent;z-index:-1;';
  let keyboardField: EditableAgentSetting | null = null;

  const syncInputs = (settings: AgentSettings): void => {
    if (document.activeElement !== endpoint) endpoint.value = settings.modelEndpoint;
    if (document.activeElement !== model) model.value = settings.modelId;
    if (document.activeElement !== key) {
      // Replacement semantics: never hydrate a stored secret back into DOM.
      key.value = '';
      key.placeholder =
        settings.modelApiKey.length > 0
          ? 'Stored key unchanged; type to replace'
          : 'Not set';
    }
    status.textContent = settings.modelEndpoint
      ? `Configured: ${settings.modelId || 'model id required'}`
      : 'Offline brain: endpoint not configured';
  };
  const saveVisibleInputs = (): void => {
    const patch: Partial<AgentSettings> = {
      modelEndpoint: endpoint.value.trim(),
      modelId: model.value.trim(),
    };
    if (key.value.trim().length > 0) {
      patch.modelApiKey = key.value.trim();
    }
    void agentState.updateSettings(patch);
    key.value = '';
    status.textContent = 'Saved locally in this browser';
  };
  const stopLocomotionKeys = (event: KeyboardEvent): void => {
    event.stopPropagation();
  };
  for (const input of Object.values(inputs)) {
    input.spellcheck = false;
    input.addEventListener('keydown', stopLocomotionKeys);
  }

  const openCard = (): void => {
    card.hidden = false;
    syncInputs(agentState.getSettings());
  };
  const closeCard = (): void => {
    card.hidden = true;
  };
  const clearStoredKey = (): void => {
    key.value = '';
    void agentState.updateSettings({ modelApiKey: '' });
    status.textContent = 'API key cleared';
  };
  launcher.addEventListener('click', openCard);
  save.addEventListener('click', saveVisibleInputs);
  clearKey.addEventListener('click', clearStoredKey);
  close.addEventListener('click', closeCard);
  // --- Share to headset (QR + one-time PIN) ---
  let activeOffer: PairingOffer | null = null;
  let ttlTimer = 0;
  const stopSharing = (): void => {
    activeOffer = null;
    window.clearInterval(ttlTimer);
    shareBox.hidden = true;
  };
  const renderTtl = (): void => {
    if (activeOffer == null) {
      return;
    }
    const seconds = Math.max(0, Math.round((activeOffer.expiresAt - Date.now()) / 1000));
    if (seconds === 0) {
      stopSharing();
      status.textContent = 'Pairing link expired; generate a new QR code.';
      return;
    }
    ttlText.textContent = `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const startSharing = (): void => {
    const settings = agentState.getSettings();
    if (settings.modelEndpoint.length === 0 || settings.modelId.length === 0) {
      status.textContent = 'Set and save endpoint + model before sharing.';
      return;
    }
    void createPairingOffer(settings).then((offer) => {
      activeOffer = offer;
      const qr = qrcode(0, 'M');
      qr.addData(offer.url, 'Byte');
      qr.make();
      qrImg.src = qr.createDataURL(5, 4);
      pinText.textContent = offer.pin;
      shareBox.hidden = false;
      window.clearInterval(ttlTimer);
      ttlTimer = window.setInterval(renderTtl, 1000);
      renderTtl();
    });
  };
  const copyShareLink = (): void => {
    if (activeOffer == null) {
      return;
    }
    void navigator.clipboard
      ?.writeText(activeOffer.url)
      .then(() => {
        status.textContent = 'Link copied; open it on the headset and enter the PIN.';
      })
      .catch(() => {
        status.textContent = 'Copy failed; scan the QR instead.';
      });
  };
  shareBtn.addEventListener('click', startSharing);
  copyLink.addEventListener('click', copyShareLink);
  stopShare.addEventListener('click', stopSharing);

  keyboardInput.addEventListener('keydown', stopLocomotionKeys);
  const commitKeyboardInput = (): void => {
    if (keyboardField == null) {
      return;
    }
    const field = keyboardField;
    keyboardField = null;
    const value = keyboardInput.value.trim();
    keyboardInput.value = '';
    // Empty secret means "keep the stored key"; clearing is explicit.
    if (field !== 'modelApiKey' || value.length > 0) {
      void agentState.updateSettings({ [field]: value });
    }
  };
  keyboardInput.addEventListener('blur', commitKeyboardInput);

  document.body.append(launcher, card, keyboardInput);
  const unsubscribeSettings = agentState.onSettingsChanged(syncInputs);
  void agentState.ready.then(() => syncInputs(agentState.getSettings()));

  activeEditor = {
    edit(field): SettingsEditResult {
      const isDesktop =
        world.visibilityState.value === VisibilityState.NonImmersive;
      if (isDesktop) {
        openCard();
        inputs[field].focus();
        inputs[field].select();
        return 'desktop';
      }
      const session = world.session as KeyboardAwareSession | null;
      if (session?.isSystemKeyboardSupported === false) {
        return 'unavailable';
      }
      const settings = agentState.getSettings();
      keyboardField = field;
      keyboardInput.type = field === 'modelApiKey' ? 'password' : 'text';
      keyboardInput.inputMode = field === 'modelEndpoint' ? 'url' : 'text';
      keyboardInput.value =
        field === 'modelApiKey' ? '' : settings[field];
      keyboardInput.placeholder =
        field === 'modelApiKey' && settings.modelApiKey.length > 0
          ? 'Stored key unchanged'
          : '';
      keyboardInput.focus();
      keyboardInput.select();
      return 'immersive';
    },
  };

  const unsubscribeVisibility = world.visibilityState.subscribe((visibility) => {
    const isDesktop = visibility === VisibilityState.NonImmersive;
    launcher.hidden = !isDesktop;
    if (!isDesktop) card.hidden = true;
  });

  return () => {
    activeEditor = null;
    stopSharing();
    unsubscribeSettings();
    unsubscribeVisibility();
    launcher.removeEventListener('click', openCard);
    save.removeEventListener('click', saveVisibleInputs);
    clearKey.removeEventListener('click', clearStoredKey);
    close.removeEventListener('click', closeCard);
    shareBtn.removeEventListener('click', startSharing);
    copyLink.removeEventListener('click', copyShareLink);
    stopShare.removeEventListener('click', stopSharing);
    for (const input of Object.values(inputs)) {
      input.removeEventListener('keydown', stopLocomotionKeys);
    }
    keyboardInput.removeEventListener('keydown', stopLocomotionKeys);
    keyboardInput.removeEventListener('blur', commitKeyboardInput);
    launcher.remove();
    card.remove();
    keyboardInput.remove();
    style.remove();
  };
}
