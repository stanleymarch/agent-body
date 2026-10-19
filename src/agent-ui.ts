/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, UIKit, UIKitMLAsset } from '@iwsdk/core';
import { agentState } from './agent/state.js';
import type { AgentSettings, MemoryRecord } from './agent/contracts.js';
import { avatarBody } from './avatar-body.js';
import {
  editAgentSetting,
  type SettingsEditResult,
} from './settings-editor.js';

const MEMORY_SLOTS = 4;

/**
 * Binds the `agent.uikitml` panel to the persistent agent state and the VRM
 * body driver. Runtime-agnostic: the same panel and behavior run in the
 * desktop browser and in Quest MR. The panel is authored in the scene under
 * node id 'agent-panel' (manifest asset id 'agent-panel'); a missing panel is
 * a silent no-op so the app runs headless.
 */
export class AgentPanelSystem extends createSystem({}) {
  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('agent-panel');
    if (panel == null) {
      console.warn('AgentPanelSystem: scene node "agent-panel" not found');
      return;
    }

    const name = panel.getElementById<UIKit.Text>('agent-name');
    const memoryCount = panel.getElementById<UIKit.Text>('memory-count');
    const memoryItems: (UIKit.Text | null)[] = [];
    for (let i = 0; i < MEMORY_SLOTS; i++) {
      memoryItems.push(
        panel.getElementById<UIKit.Text>(`memory-item-${i}`),
      );
    }
    const addNote = panel.getElementById('btn-add-note');
    const toggleIdle = panel.getElementById('btn-toggle-idle');
    const toggleGaze = panel.getElementById('btn-toggle-gaze');
    const idleLabel = panel.getElementById<UIKit.Text>('btn-toggle-idle-label');
    const gazeLabel = panel.getElementById<UIKit.Text>('btn-toggle-gaze-label');
    const memoryContent = panel.getElementById('memory-content');
    const settingsView = panel.getElementById('settings-view');
    const openSettings = panel.getElementById('btn-open-settings');
    const backSettings = panel.getElementById('btn-back-settings');
    const editEndpoint = panel.getElementById('btn-edit-endpoint');
    const editModel = panel.getElementById('btn-edit-model');
    const editKey = panel.getElementById('btn-edit-key');
    const clearKey = panel.getElementById('btn-clear-key');
    const settingsSummary =
      panel.getElementById<UIKit.Text>('settings-summary');
    const settingsHelp = panel.getElementById<UIKit.Text>('settings-help');
    const endpointLabel =
      panel.getElementById<UIKit.Text>('settings-endpoint-label');
    const modelLabel =
      panel.getElementById<UIKit.Text>('settings-model-label');
    const keyLabel = panel.getElementById<UIKit.Text>('settings-key-label');

    const refresh = (settings: AgentSettings, memories: MemoryRecord[]): void => {
      name?.setProperties({ text: settings.agentName });
      memoryCount?.setProperties({
        text: `${memories.length} memories`,
      });
      for (let i = 0; i < MEMORY_SLOTS; i++) {
        memoryItems[i]?.setProperties({
          text: memories[i]?.text ?? '-',
        });
      }
      idleLabel?.setProperties({
        text: `Idle: ${settings.idleMotion ? 'On' : 'Off'}`,
      });
      gazeLabel?.setProperties({
        text: `Gaze: ${settings.gazeTracking ? 'On' : 'Off'}`,
      });
      let endpointName = 'Not set';
      if (settings.modelEndpoint.length > 0) {
        try {
          endpointName = new URL(settings.modelEndpoint).host;
        } catch {
          endpointName = 'Invalid URL';
        }
      }
      settingsSummary?.setProperties({
        text:
          settings.modelEndpoint.length > 0 && settings.modelId.length > 0
            ? 'Live model configured'
            : 'Offline brain',
      });
      endpointLabel?.setProperties({ text: `Endpoint: ${endpointName}` });
      modelLabel?.setProperties({
        text: `Model: ${settings.modelId || 'Not set'}`,
      });
      keyLabel?.setProperties({
        text: `API Key: ${settings.modelApiKey.length > 0 ? 'Set' : 'Not set'}`,
      });
    };

    const onSettings = (settings: AgentSettings): void => {
      refresh(settings, lastMemories);
    };
    const onMemories = (): void => {
      void agentState.recentMemories(MEMORY_SLOTS).then((memories) => {
        lastMemories = memories;
        refresh(agentState.getSettings(), memories);
      });
    };

    let lastMemories: MemoryRecord[] = [];
    this.cleanupFuncs.push(
      agentState.onSettingsChanged(onSettings),
      agentState.onMemoriesChanged(onMemories),
    );

    const onAddNote = (): void => {
      const now = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      void agentState.addMemory(`Noted at ${stamp}`, 'note');
    };
    const onToggleIdle = (): void => {
      const next = !agentState.getSettings().idleMotion;
      avatarBody.setIdleMotion(next);
      void agentState.updateSettings({ idleMotion: next });
    };
    const onToggleGaze = (): void => {
      const next = !agentState.getSettings().gazeTracking;
      avatarBody.setAttentionTarget(next ? this.world.camera : null);
      void agentState.updateSettings({ gazeTracking: next });
    };
    const setSettingsView = (visible: boolean): void => {
      memoryContent?.setProperties({ display: visible ? 'none' : 'flex' });
      addNote?.setProperties({ display: visible ? 'none' : 'flex' });
      toggleIdle?.setProperties({ display: visible ? 'none' : 'flex' });
      toggleGaze?.setProperties({ display: visible ? 'none' : 'flex' });
      openSettings?.setProperties({ display: visible ? 'none' : 'flex' });
      settingsView?.setProperties({ display: visible ? 'flex' : 'none' });
    };
    const showEditResult = (result: SettingsEditResult): void => {
      const text =
        result === 'immersive'
          ? 'Use the system keyboard, then press Done.'
          : result === 'desktop'
            ? 'Edit and save in the browser settings card.'
            : 'System keyboard unavailable. Edit in browser mode.';
      settingsHelp?.setProperties({ text });
    };
    const onOpenSettings = (): void => {
      setSettingsView(true);
    };
    const onBackSettings = (): void => {
      setSettingsView(false);
    };
    const onEditEndpoint = (): void => {
      showEditResult(editAgentSetting('modelEndpoint'));
    };
    const onEditModel = (): void => {
      showEditResult(editAgentSetting('modelId'));
    };
    const onEditKey = (): void => {
      showEditResult(editAgentSetting('modelApiKey'));
    };
    const onClearKey = (): void => {
      void agentState.updateSettings({ modelApiKey: '' });
      settingsHelp?.setProperties({ text: 'API key cleared.' });
    };
    setSettingsView(false);


    addNote?.addEventListener('click', onAddNote);
    toggleIdle?.addEventListener('click', onToggleIdle);
    toggleGaze?.addEventListener('click', onToggleGaze);
    openSettings?.addEventListener('click', onOpenSettings);
    backSettings?.addEventListener('click', onBackSettings);
    editEndpoint?.addEventListener('click', onEditEndpoint);
    editModel?.addEventListener('click', onEditModel);
    editKey?.addEventListener('click', onEditKey);
    clearKey?.addEventListener('click', onClearKey);
    this.cleanupFuncs.push(
      () => addNote?.removeEventListener('click', onAddNote),
      () => toggleIdle?.removeEventListener('click', onToggleIdle),
      () => toggleGaze?.removeEventListener('click', onToggleGaze),
      () => openSettings?.removeEventListener('click', onOpenSettings),
      () => backSettings?.removeEventListener('click', onBackSettings),
      () => editEndpoint?.removeEventListener('click', onEditEndpoint),
      () => editModel?.removeEventListener('click', onEditModel),
      () => editKey?.removeEventListener('click', onEditKey),
      () => clearKey?.removeEventListener('click', onClearKey),
    );

    // First refresh once the DB is open; init itself stays synchronous.
    void agentState.ready.then(() => {
      onMemories();
      refresh(agentState.getSettings(), lastMemories);
    });
  }
}
