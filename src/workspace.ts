import { createSystem, SessionMode, UIKitMLAsset, Visibility, VisibilityState } from '@iwsdk/core';
import qrcode from 'qrcode-generator';
import { agentState } from './agent/state.js';
import { agentBrain } from './agent/brain.js';
import type { AgentSettings, MemoryRecord } from './agent/contracts.js';
import { speak, getSpeechStatus, onSpeechStatus } from './agent/tts.js';
import { startListening, cancelListening, type ListeningSession } from './agent/stt.js';
import { getCharacterStatus, onCharacterStatus, BUNDLED_CHARACTER_PRESET } from './agent/character.js';
import { getAvatarCue, onAvatarCue } from './agent/cues.js';
import type { AvatarCue } from './agent/contracts.js';
import { createPairingOffer } from './pairing.js';
import { CHARACTER_FIELDS, CONNECTION_FIELDS, PROVIDER_LABELS, type SettingField, type WorkspaceTab, type ConnectionTab } from './workspace-fields.js';
import './workspace.css';

const TAB_LABELS: Record<WorkspaceTab, string> = { chat: 'Dialogue', character: 'Character', connections: 'Connections', memory: 'Memory' };
const SUB_LABELS: Record<ConnectionTab, string> = { llm: 'LLM', stt: 'STT', tts: 'TTS', transfer: 'Transfer' };

/** One workspace, two presentation adapters; never two visible copies. */
export class WorkspaceSystem extends createSystem({}) {
  init(): void {
    const world = this.world;
    const panel = world.requireSceneObject<UIKitMLAsset>('agent-panel');
    const panelEntity = world.requireSceneEntity('agent-panel');
    const root = document.createElement('aside');
    root.id = 'agent-workspace';
    root.setAttribute('aria-label', 'Agent workspace');
    root.innerHTML = `
      <header class="workspace-header"><div class="avatar-monogram">A</div><div><h1 id="workspace-name">Ava</h1><div id="connection-status">Offline demo</div></div></header>
      <nav class="workspace-nav" aria-label="Workspace sections"></nav>
      <section class="workspace-content"></section>
      <div id="workspace-feedback" role="status" aria-live="polite"></div>
      <form id="chat-composer"><textarea id="chat-message" aria-label="Message" placeholder="Write a message..." rows="2"></textarea><div class="composer-actions"><button id="chat-mic" class="secondary-action" type="button">Microphone</button><button id="chat-send" class="primary-action" type="submit">Send</button></div></form>
      <footer class="workspace-footer"><button id="enter-mr" class="secondary-action" hidden>Enter MR</button><button id="enter-vr" class="primary-action" hidden>Enter VR</button></footer>`;
    const stageLabel = document.createElement('div');
    stageLabel.className = 'stage-label';
    stageLabel.textContent = 'Agent Body / shared spatial world';
    const stageHelp = document.createElement('div');
    stageHelp.className = 'stage-help';
    stageHelp.textContent = 'WASD move / Right mouse look';
    const keyboard = document.createElement('input');
    keyboard.id = 'xr-keyboard';
    keyboard.autocomplete = 'off';
    keyboard.setAttribute('aria-label', 'Immersive text editor');
    document.body.append(root, stageLabel, stageHelp, keyboard);
    const content = root.querySelector<HTMLElement>('.workspace-content')!;
    const nav = root.querySelector<HTMLElement>('.workspace-nav')!;
    const name = root.querySelector<HTMLElement>('#workspace-name')!;
    const connection = root.querySelector<HTMLElement>('#connection-status')!;
    const feedback = root.querySelector<HTMLElement>('#workspace-feedback')!;
    const composer = root.querySelector<HTMLFormElement>('#chat-composer')!;
    const message = root.querySelector<HTMLTextAreaElement>('#chat-message')!;
    const sendButton = root.querySelector<HTMLButtonElement>('#chat-send')!;
    const micButton = root.querySelector<HTMLButtonElement>('#chat-mic')!;
    const mrButton = root.querySelector<HTMLButtonElement>('#enter-mr')!;
    const vrButton = root.querySelector<HTMLButtonElement>('#enter-vr')!;
    let tab: WorkspaceTab = 'chat';
    let sub: ConnectionTab = 'llm';
    let draft = agentState.getSettings();
    let dirty = false;
    let pending: Partial<AgentSettings> = {};
    const changeDraft = (patch: Partial<AgentSettings>): void => {
      Object.assign(pending, patch);
      Object.assign(draft, patch);
      dirty = true;
    };
    let memories: MemoryRecord[] = [];
    let busy = false;
    let capture: ListeningSession | null = null;
    let editing: keyof AgentSettings | 'chat' | null = null;
    let shareTimer: number | undefined;
    let shareGeneration = 0;
    let disposed = false;
    let cue: AvatarCue | null = getAvatarCue();
    const cueLabel = (): string =>
      cue == null || (cue.emotion === 'neutral' && cue.gesture === 'none')
        ? ''
        : ` · ${cue.emotion}${cue.gesture !== 'none' ? ` · ${cue.gesture}` : ''}`;
    const disposers: (() => void)[] = [];

    const showFeedback = (text: string, error = false): void => {
      feedback.textContent = text;
      feedback.dataset.error = String(error);
      panel.getElementById('workspace-feedback')?.setProperties({ text: text.slice(0, 180) });
    };
    const currentFields = (): SettingField[] => {
      if (tab === 'character') return CHARACTER_FIELDS;
      if (tab !== 'connections' || sub === 'transfer') return [];
      const fields = CONNECTION_FIELDS[sub];
      if (sub === 'llm') return fields;
      const provider = draft[sub === 'stt' ? 'sttProvider' : 'ttsProvider'];
      return fields.filter((field) => field.kind === 'provider' ||
        (provider !== 'off' && field.key === 'speechLanguage') ||
        (provider === 'browser' && field.key === 'ttsVoice') ||
        provider === 'openai');
    };
    const renderSpatial = (): void => {
      const settings = agentState.getSettings();
      panel.getElementById('workspace-title')?.setProperties({ text: `${settings.agentName} / ${TAB_LABELS[tab]}` });
      panel.getElementById('workspace-status')?.setProperties({ text: (dirty ? 'Unsaved changes' : agentBrain.mode === 'live' ? `LLM: ${settings.modelId}` : 'Offline demo / no model connected') + cueLabel() });
      for (const key of Object.keys(TAB_LABELS) as WorkspaceTab[]) {
        panel.getElementById(`nav-${key}`)?.setProperties({ backgroundColor: tab === key ? '#526ea7' : '#2a3d5c' });
      }
      panel.getElementById('connection-tabs')?.setProperties({ display: tab === 'connections' ? 'flex' : 'none' });
      let body = '';
      if (tab === 'chat') {
        body = memories.filter((record) => record.kind === 'chat').slice(0, 2).reverse().map((record) => `${record.role === 'user' ? 'You' : record.role === 'assistant' ? settings.agentName : 'Archive'}: ${record.text.slice(0, 220)}`).join('\n\n') || 'Write a message or use the microphone. Configure LLM, STT and TTS in Connections.';
      } else if (tab === 'character') {
        body = `${draft.characterVrmUrl ? 'Custom VRM' : 'Ava / bundled VRM 1.0'}\n${getCharacterStatus().error || 'Procedural blink, breathing and gaze. No animation pack.'}`;
      } else if (tab === 'memory') {
        body = memories.filter((record) => record.kind !== 'chat').slice(0, 5).map((record) => record.text.slice(0, 100)).join('\n\n') || 'No saved facts or notes yet. Conversation and long-term memory persist on this device.';
      } else if (sub === 'transfer') {
        body = 'Prepare connections on a desktop. Use Transfer to display an encrypted QR link. Open the link on this device and enter its PIN. Never publish API keys.';
      } else {
        body = sub === 'llm' ? 'OpenAI-compatible chat/completions. Select a field to edit with the system keyboard.' : `${sub.toUpperCase()}: separate provider, model and key. Browser engines depend on runtime support.`;
      }
      panel.getElementById('workspace-body')?.setProperties({ text: body });
      const fields = currentFields();
      for (let index = 0; index < 6; index++) {
        const field = fields[index];
        panel.getElementById(`field-${index}`)?.setProperties({ display: field ? 'flex' : 'none' });
        if (!field) continue;
        const value = draft[field.key];
        const text = field.kind === 'secret' ? (value ? 'Stored (hidden)' : 'Not set') : field.kind === 'toggle' ? (value ? 'On' : 'Off') : field.kind === 'provider' ? PROVIDER_LABELS[String(value)] : String(value || 'Not set');
        panel.getElementById(`field-label-${index}`)?.setProperties({ text: `${field.label}: ${text.slice(0, 55)}` });
      }
      panel.getElementById('workspace-save')?.setProperties({ display: fields.length ? 'flex' : 'none' });
      panel.getElementById('workspace-edit-chat')?.setProperties({ display: tab === 'chat' ? 'flex' : 'none' });
      panel.getElementById('workspace-listen')?.setProperties({ display: tab === 'chat' ? 'flex' : 'none' });
      panel.getElementById('workspace-test-voice')?.setProperties({ display: tab === 'connections' && sub === 'tts' ? 'flex' : 'none' });
      panel.getElementById('workspace-clear-key')?.setProperties({ display: fields.some((field) => field.kind === 'secret') ? 'flex' : 'none' });
    };
    const save = async (): Promise<boolean> => {
      try {
        const patch = { ...pending };
        await agentState.updateSettings(patch);
        for (const key of Object.keys(patch) as (keyof AgentSettings)[]) {
          if (pending[key] === patch[key]) delete pending[key];
        }
        draft = { ...agentState.getSettings(), ...pending };
        dirty = Object.keys(pending).length > 0;
        showFeedback('Saved on this device.');
        renderSpatial();
        renderDesktop();
        return true;
      } catch (error) {
        showFeedback(error instanceof Error ? error.message : String(error), true);
        return false;
      }
    };
    const submit = (text: string): void => {
      if (disposed || !text.trim() || busy) return;
      busy = true;
      sendButton.disabled = true;
      showFeedback('Thinking...');
      void agentBrain.send(text).then(() => showFeedback('')).catch((error: unknown) => showFeedback(String(error), true)).finally(() => {
        busy = false;
        sendButton.disabled = false;
      });
    };
    const microphone = (): void => {
      if (capture) {
        capture.stop();
        micButton.textContent = 'Finishing recording...';
        return;
      }
      micButton.disabled = true;
      void startListening((text) => {
        if (disposed) return;
        capture = null;
        micButton.textContent = 'Microphone';
        showFeedback(text ? 'Transcript received.' : 'No speech detected.');
        submit(text);
      }, (status) => {
        if (disposed) return;
        showFeedback(status);
        if (/stopped|error|failed|denied|unsupported|unavailable|cancel|complete|No speech|disabled/i.test(status)) {
          capture = null;
          micButton.textContent = 'Microphone';
        }
      }).then((session) => {
        if (disposed) { session.cancel(); return; }
        capture = session.active ? session : null;
        micButton.textContent = session.active ? 'Stop recording' : 'Microphone';
      }).catch((error: unknown) => showFeedback(String(error), true)).finally(() => { micButton.disabled = false; });
    };
    const testVoice = (): void => {
      keyboard.blur();
      void save().then((saved) => saved ? speak('Hello. These are the voice settings for your companion.') : undefined).catch((error: unknown) => showFeedback(String(error), true));
    };
    const renderFields = (): void => {
      const fields = currentFields();
      for (const field of fields) {
        const label = document.createElement('label');
        label.textContent = field.label;
        const id = `setting-${field.key}`;
        label.htmlFor = id;
        const input = field.kind === 'multiline' ? document.createElement('textarea') : field.kind === 'provider' ? document.createElement('select') : document.createElement('input');
        input.id = id;
        input.autocomplete = 'off';
        if (input instanceof HTMLSelectElement) {
          for (const [value, title] of Object.entries(PROVIDER_LABELS)) {
            const option = document.createElement('option'); option.value = value; option.textContent = title; input.append(option);
          }
        } else if (input instanceof HTMLInputElement) {
          input.type = field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : field.kind === 'toggle' ? 'checkbox' : 'text';
          if (field.kind === 'number') { input.min = '0.5'; input.max = '2'; input.step = '0.05'; }
          if (field.kind === 'toggle') { input.checked = Boolean(draft[field.key]); label.className = 'toggle-field'; }
        }
        if (field.kind !== 'secret' && field.kind !== 'toggle') input.value = String(draft[field.key]);
        if (!(input instanceof HTMLSelectElement)) input.placeholder = field.kind === 'secret' && draft[field.key] ? 'Stored key unchanged; type to replace' : field.placeholder || '';
        input.addEventListener(field.kind === 'provider' || field.kind === 'toggle' ? 'change' : 'input', () => {
          const value = field.kind === 'toggle' ? (input as HTMLInputElement).checked : field.kind === 'number' ? Number(input.value) : input.value;
          if (field.kind === 'secret' && value === '') return;
          changeDraft({ [field.key]: value });
          if (field.key === 'ttsProvider' && value === 'browser') changeDraft({ ttsVoice: '' });
          renderSpatial();
          if (field.kind === 'provider') renderDesktop();
        });
        if (field.kind === 'toggle') { label.append(input); content.append(label); }
        else { content.append(label); if (field.kind === 'secret') {
          const row = document.createElement('div'); row.className = 'field-secret';
          const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear'; clear.setAttribute('aria-label', `Clear ${field.label}`);
          clear.addEventListener('click', () => { changeDraft({ [field.key]: '' }); input.value = ''; if (input instanceof HTMLInputElement) input.placeholder = 'Not set'; showFeedback('Key removed from draft. Save to apply.'); renderSpatial(); });
          row.append(input, clear); content.append(row);
        } else content.append(input); }
        if (field.help) { const help = document.createElement('small'); help.className = 'field-help'; help.textContent = field.help; content.append(help); }
        if (field.key === 'ttsVoice' && draft.ttsProvider === 'browser') {
          const voices = document.createElement('datalist'); voices.id = 'browser-voices';
          for (const voice of window.speechSynthesis?.getVoices() ?? []) { const option = document.createElement('option'); option.value = voice.voiceURI; option.label = `${voice.name} / ${voice.lang}`; voices.append(option); }
          if (input instanceof HTMLInputElement) input.setAttribute('list', voices.id);
          content.append(voices);
        }
      }
      const actions = document.createElement('div'); actions.className = 'form-actions';
      const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'primary-action'; apply.textContent = 'Save settings'; apply.addEventListener('click', () => { void save(); }); actions.append(apply);
      if (tab === 'character') { const reset = document.createElement('button'); reset.className = 'secondary-action'; reset.textContent = 'Use bundled VRM'; reset.addEventListener('click', () => { changeDraft({ characterVrmUrl: '', characterScale: 1 }); renderDesktop(); renderSpatial(); }); actions.append(reset); }
      if (tab === 'connections' && sub === 'tts') { const test = document.createElement('button'); test.className = 'secondary-action'; test.textContent = 'Test voice'; test.addEventListener('click', testVoice); actions.append(test); }
      content.append(actions);
    };
    const renderTransfer = (): void => {
      const help = document.createElement('p'); help.textContent = 'Save LLM and speech settings first. The QR link transfers encrypted settings to another browser. It does not sync this device or revoke copied links.'; content.append(help);
      const create = document.createElement('button'); create.className = 'primary-action'; create.textContent = 'Generate settings QR';
      const share = document.createElement('div'); share.id = 'pairing-share';
      create.addEventListener('click', () => {
        const generation = ++shareGeneration;
        create.disabled = true;
        void createPairingOffer(agentState.getSettings()).then((offer) => {
          if (disposed || generation !== shareGeneration) return;
          const qr = qrcode(0, 'M'); qr.addData(offer.url); qr.make();
          share.replaceChildren();
          const image = document.createElement('img'); image.alt = 'Encrypted settings QR'; image.src = qr.createDataURL(5, 20);
          const pin = document.createElement('div'); pin.id = 'pairing-pin'; pin.textContent = offer.pin;
          const instructions = document.createElement('p'); instructions.textContent = 'Scan/open the link on the receiving device, then enter this PIN. Treat QR + PIN together as a secret. Valid for 10 minutes.';
          const copy = document.createElement('button'); copy.className = 'secondary-action'; copy.textContent = 'Copy pairing link'; copy.addEventListener('click', () => { void navigator.clipboard.writeText(offer.url).then(() => showFeedback('Pairing link copied.')).catch(() => showFeedback('Clipboard access denied.', true)); });
          share.append(image, pin, instructions, copy);
          clearTimeout(shareTimer); shareTimer = setTimeout(() => { share.replaceChildren(); showFeedback('QR display expired.'); }, Math.max(0, offer.expiresAt - Date.now()));
        }).catch((error: unknown) => showFeedback(String(error), true)).finally(() => { create.disabled = false; });
      });
      content.append(create, share);
    };
    const renderDesktop = (): void => {
      content.replaceChildren();
      composer.hidden = tab !== 'chat';
      for (const button of nav.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
      const heading = document.createElement('h2'); heading.textContent = TAB_LABELS[tab]; content.append(heading);
      if (tab === 'chat') {
        const chats = memories.filter((record) => record.kind === 'chat').reverse();
        if (!chats.length) { const empty = document.createElement('div'); empty.className = 'chat-empty'; empty.innerHTML = '<div class="eyebrow">Your spatial companion</div><h2>A conversation,<br>with a presence.</h2><p>Connect a model in Connections, choose speech providers, then start talking. Your character and memory stay with you in browser, MR and VR.</p>'; content.append(empty); }
        for (const record of chats) { const bubble = document.createElement('div'); bubble.className = `message ${record.role || 'archive'}`; const role = document.createElement('span'); role.className = 'message-role'; role.textContent = record.role === 'user' ? 'You' : record.role === 'assistant' ? draft.agentName : 'Archive'; const text = document.createTextNode(record.text); bubble.append(role, text); content.append(bubble); }
        content.scrollTop = content.scrollHeight;
      } else if (tab === 'character') {
        const card = document.createElement('div'); card.className = 'character-preset';
        const title = document.createElement('strong'); title.textContent = draft.characterVrmUrl ? 'Custom VRM character' : 'Ava / built-in preset';
        const desc = document.createElement('small'); desc.textContent = draft.characterVrmUrl ? 'Your custom VRM source. Loaded with the same character, voice and memory settings.' : `${BUNDLED_CHARACTER_PRESET.modelName} / VRM 1.0. Procedural blink, breathing and gaze; no embedded animation clips.`;
        card.append(title, desc); content.append(card);
        const state = document.createElement('div'); state.className = 'character-status'; state.textContent = getCharacterStatus().error || (getCharacterStatus().ready ? 'Avatar loaded in the shared scene.' : 'Loading avatar...'); content.append(state); renderFields();
      } else if (tab === 'connections') {
        const tabs = document.createElement('div'); tabs.className = 'connection-nav';
        for (const key of Object.keys(SUB_LABELS) as ConnectionTab[]) { const button = document.createElement('button'); button.textContent = SUB_LABELS[key]; button.setAttribute('aria-selected', String(sub === key)); button.addEventListener('click', () => { sub = key; renderDesktop(); renderSpatial(); }); tabs.append(button); } content.append(tabs);
        if (sub === 'transfer') renderTransfer(); else { const description = document.createElement('p'); description.textContent = sub === 'llm' ? 'Language model. Credentials are stored on this device only. The endpoint must allow this site through CORS.' : sub === 'tts' ? 'Speech output. Select a browser voice or a provider model/voice. Browser synthesis is available only when the runtime provides voices.' : 'Microphone input. Browser recognition requires runtime support. OpenAI-compatible recognition records audio only while the microphone is active.'; content.append(description); renderFields(); }
      } else {
        const records = memories.filter((record) => record.kind !== 'chat');
        const info = document.createElement('p'); info.textContent = records.length ? 'Saved facts and notes on this device.' : 'No saved facts yet. The agent can use its memory tools during a conversation.'; content.append(info);
        for (const record of records) { const item = document.createElement('div'); item.className = 'memory-record'; item.textContent = record.text; content.append(item); }
      }
    };
    const selectTab = (next: WorkspaceTab): void => { tab = next; renderDesktop(); renderSpatial(); };
    for (const key of Object.keys(TAB_LABELS) as WorkspaceTab[]) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.tab = key; button.textContent = TAB_LABELS[key]; button.addEventListener('click', () => selectTab(key)); nav.append(button);
      const spatial = panel.requireElementById(`nav-${key}`); const click = (): void => selectTab(key); spatial.addEventListener('click', click); disposers.push(() => spatial.removeEventListener('click', click));
    }
    for (const key of Object.keys(SUB_LABELS) as ConnectionTab[]) {
      const spatial = panel.requireElementById(`sub-${key}`); const click = (): void => { sub = key; renderDesktop(); renderSpatial(); }; spatial.addEventListener('click', click); disposers.push(() => spatial.removeEventListener('click', click));
    }
    const editSpatial = (field: SettingField | 'chat'): void => {
      if (field !== 'chat' && field.kind === 'toggle') { changeDraft({ [field.key]: !draft[field.key] }); renderSpatial(); return; }
      if (field !== 'chat' && field.kind === 'provider') {
        const values = ['off', 'browser', 'openai'];
        const next = values[(values.indexOf(String(draft[field.key])) + 1) % 3];
        changeDraft({ [field.key]: next });
        if (field.key === 'ttsProvider' && next === 'browser') changeDraft({ ttsVoice: '' });
        renderSpatial();
        return;
      }
      if ((world.session as (XRSession & { isSystemKeyboardSupported?: boolean }) | null)?.isSystemKeyboardSupported === false) { showFeedback('System keyboard unavailable. Configure through browser mode or QR.', true); return; }
      keyboard.blur();
      editing = field === 'chat' ? 'chat' : field.key;
      keyboard.type = field !== 'chat' && field.kind === 'secret' ? 'password' : 'text';
      keyboard.value = field === 'chat' || field.kind === 'secret' ? '' : String(draft[field.key]);
      keyboard.focus(); keyboard.select(); showFeedback(field === 'chat' ? 'Write your message, then press Done.' : 'Edit field, then Done. Use Save to apply changes.');
    };
    for (let index = 0; index < 6; index++) {
      const button = panel.requireElementById(`field-${index}`); const click = (): void => { const field = currentFields()[index]; if (field) editSpatial(field); }; button.addEventListener('click', click); disposers.push(() => button.removeEventListener('click', click));
    }
    const commitKeyboard = (): void => {
      const field = editing; editing = null; if (!field) return;
      const text = keyboard.value.trim(); keyboard.value = '';
      if (field === 'chat') submit(text);
      else if (text || !field.endsWith('ApiKey')) { changeDraft({ [field]: field === 'characterScale' ? Number(text) : text }); renderSpatial(); renderDesktop(); }
    };
    keyboard.addEventListener('blur', commitKeyboard);
    const keyboardDone = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); keyboard.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); editing = null; keyboard.value = ''; keyboard.blur(); }
    };
    keyboard.addEventListener('keydown', keyboardDone);
    const submitForm = (event: SubmitEvent): void => { event.preventDefault(); const text = message.value; message.value = ''; submit(text); };
    composer.addEventListener('submit', submitForm); micButton.addEventListener('click', microphone);
    const submitOnEnter = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        composer.requestSubmit();
      }
    };
    message.addEventListener('keydown', submitOnEnter);
    const stopKeys = (event: KeyboardEvent): void => event.stopPropagation();
    root.addEventListener('keydown', stopKeys); root.addEventListener('keyup', stopKeys); keyboard.addEventListener('keydown', stopKeys); keyboard.addEventListener('keyup', stopKeys);
    const spatialActions: Record<string, () => void> = {
      'workspace-edit-chat': () => editSpatial('chat'), 'workspace-listen': microphone,
      'workspace-save': () => { keyboard.blur(); void save(); }, 'workspace-test-voice': testVoice,
      'workspace-clear-key': () => {
        const field = currentFields().find((item) => item.kind === 'secret');
        editing = null; keyboard.value = ''; keyboard.blur();
        if (field) { changeDraft({ [field.key]: '' }); showFeedback('Key removed from draft. Save to apply.'); renderSpatial(); }
      },
      'workspace-exit': () => world.exitXR(),
    };
    for (const [id, callback] of Object.entries(spatialActions)) { const button = panel.requireElementById(id); button.addEventListener('click', callback); disposers.push(() => button.removeEventListener('click', callback)); }
    const updateMode = (state: VisibilityState): void => {
      const desktop = state === VisibilityState.NonImmersive;
      root.hidden = !desktop; stageLabel.hidden = !desktop; stageHelp.hidden = !desktop;
      panelEntity.setValue(Visibility, 'isVisible', !desktop);
      const space = world.getSceneObject('vr-space');
      if (space) space.visible = desktop || world.session?.environmentBlendMode === 'opaque';
      if (!desktop && root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      if (desktop) renderDesktop();
    };
    const connectionText = (): string => {
      const settings = agentState.getSettings();
      return (agentBrain.mode === 'live'
        ? `${settings.modelId || 'No model ID'} / endpoint configured`
        : 'Offline demo / connect a model') + cueLabel();
    };
    const launchMR = (): void => { world.launchXR({ sessionMode: SessionMode.ImmersiveAR }); };
    const launchVR = (): void => { world.launchXR({ sessionMode: SessionMode.ImmersiveVR, features: { anchors: false, hitTest: false, planeDetection: false, meshDetection: false } }); };
    mrButton.addEventListener('click', launchMR); vrButton.addEventListener('click', launchVR);
    if (navigator.xr && world.xrEnabled) {
      void Promise.all([navigator.xr.isSessionSupported('immersive-ar'), navigator.xr.isSessionSupported('immersive-vr')]).then(([ar, vr]) => { if (!disposed) { mrButton.hidden = !ar; vrButton.hidden = !vr; } }).catch(() => showFeedback('Immersive sessions unavailable in this browser.'));
    }
    const refreshSettings = (settings: AgentSettings): void => {
      draft = { ...settings, ...pending };
      name.textContent = settings.agentName;
      connection.textContent = connectionText();
      renderSpatial();
      if (!dirty) renderDesktop();
    };
    const applyCue = (next: AvatarCue | null): void => {
      cue = next;
      connection.textContent = connectionText();
      renderSpatial();
    };
    disposers.push(onAvatarCue(applyCue));
    const refreshMemories = (): void => {
      void agentState.recentMemories(100).then((records) => { if (disposed) return; memories = records; if (tab === 'chat' || tab === 'memory') renderDesktop(); renderSpatial(); });
    };
    disposers.push(agentState.onSettingsChanged(refreshSettings), agentState.onMemoriesChanged(refreshMemories), world.visibilityState.subscribe(updateMode), onSpeechStatus((status) => showFeedback(status)), onCharacterStatus(() => { renderSpatial(); if (tab === 'character' && !dirty) renderDesktop(); }));
    void agentState.ready.then(() => { if (disposed) return; refreshSettings(agentState.getSettings()); refreshMemories(); renderDesktop(); });
    renderDesktop(); renderSpatial(); updateMode(world.visibilityState.value);
    if (getSpeechStatus()) showFeedback(getSpeechStatus());
    this.cleanupFuncs.push(() => {
      disposed = true; cancelListening(); capture?.cancel(); clearTimeout(shareTimer); shareGeneration++;
      message.removeEventListener('keydown', submitOnEnter);
      keyboard.removeEventListener('keydown', keyboardDone);
      for (const dispose of disposers) dispose();
      keyboard.removeEventListener('blur', commitKeyboard); root.removeEventListener('keydown', stopKeys); root.removeEventListener('keyup', stopKeys); keyboard.removeEventListener('keydown', stopKeys); keyboard.removeEventListener('keyup', stopKeys);
      mrButton.removeEventListener('click', launchMR); vrButton.removeEventListener('click', launchVR); composer.removeEventListener('submit', submitForm); micButton.removeEventListener('click', microphone);
      root.remove(); keyboard.remove(); stageLabel.remove(); stageHelp.remove();
    });
  }
}
