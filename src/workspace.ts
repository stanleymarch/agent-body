import { createSystem, ScreenSpace, SessionMode, UIKitMLAsset, Visibility, VisibilityState } from '@iwsdk/core';
import qrcode from 'qrcode-generator';
import { agentState } from './agent/state.js';
import { OPENROUTER_FREE_PRESET } from './agent/settings.js';
import { agentBrain } from './agent/brain.js';
import type { AgentSettings, MemoryRecord } from './agent/contracts.js';
import { speak, hush, getSpeechStatus, onSpeechStatus } from './agent/tts.js';
import { startListening, cancelListening, type ListeningSession } from './agent/stt.js';
import { getCharacterStatus, onCharacterStatus, BUNDLED_CHARACTER_PRESET } from './agent/character.js';
import { getAvatarCue, onAvatarCue } from './agent/cues.js';
import { getPerceptionStatus, onPerceptionStatus, getRoomSummary } from './agent/perception.js';
import { createPairingOffer, consumePairingUrl, parsePairingFragment, type PairingOffer } from './pairing.js';
import { CHARACTER_FIELDS, CONNECTION_FIELDS, PROVIDER_LABELS, type SettingField, type WorkspaceTab, type ConnectionTab } from './workspace-fields.js';
import './workspace.css';

const TAB_LABELS: Record<WorkspaceTab, string> = { chat: 'Dialogue', character: 'Character', connections: 'Connections', memory: 'Memory' };
const SUB_LABELS: Record<ConnectionTab, string> = { llm: 'LLM', stt: 'STT', tts: 'TTS', transfer: 'Transfer' };
type EditorTarget = SettingField | 'chat' | 'note' | 'search' | 'pin';

// Capture only in memory and remove the encrypted fragment before world bootstrap.
// No PIN or ciphertext is written to storage, analytics, or logs.
let pendingPairingUrl = typeof window !== 'undefined' && parsePairingFragment(window.location.hash) ? window.location.href : '';
if (pendingPairingUrl) window.history.replaceState(null, '', window.location.pathname + window.location.search);

/** One Horizon UIKitML surface and controller in browser, MR and VR. */
export class WorkspaceSystem extends createSystem({}) {
  init(): void {
    const world = this.world;
    const panel = world.requireSceneObject<UIKitMLAsset>('agent-panel');
    const panelEntity = world.requireSceneEntity('agent-panel');
    const disposers: (() => void)[] = [];
    let disposed = false;
    let receivingUrl = pendingPairingUrl;
    pendingPairingUrl = '';
    let receivingPin = '';
    let receivingBusy = false;
    let tab: WorkspaceTab = receivingUrl ? 'connections' : 'chat';
    let sub: ConnectionTab = receivingUrl ? 'transfer' : 'llm';
    let draft = agentState.getSettings();
    const pending: Partial<AgentSettings> = {};
    let busy = false;
    let capture: ListeningSession | null = null;
    let microphoneStarting = false;
    let records: MemoryRecord[] = [];
    let search = '';
    let page = 0;
    let recordGeneration = 0;
    let editing: EditorTarget | null = null;
    let composing = false;
    let confirmingClear = false;
    let pairing: PairingOffer | null = null;
    let pairingGeneration = 0;
    let pairingTimer: number | undefined;
    let pairingBusy = false;
    let supportsMR = false;
    let supportsVR = false;
    let cue = getAvatarCue();
    let cameraStatus = getPerceptionStatus();

    // Native editing only: no duplicate DOM navigation, settings or business UI.
    // A focused DOM input is also the documented Quest system-keyboard bridge.
    const bridge = document.createElement('div');
    bridge.id = 'workspace-keyboard-bridge';
    bridge.hidden = true;
    const bridgeLabel = document.createElement('label');
    bridgeLabel.id = 'workspace-keyboard-label';
    const textInput = document.createElement('textarea');
    textInput.id = 'workspace-native-text';
    textInput.rows = 3;
    const secretInput = document.createElement('input');
    secretInput.id = 'workspace-native-secret';
    secretInput.type = 'password';
    for (const input of [textInput, secretInput]) {
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-labelledby', bridgeLabel.id);
    }
    bridge.append(bridgeLabel, textInput, secretInput);
    document.body.append(bridge);
    let input: HTMLTextAreaElement | HTMLInputElement = textInput;
    const setText = (id: string, text: string): void => { panel.requireElementById(id).setProperties({ text }); };
    const show = (id: string, visible: boolean): void => { panel.requireElementById(id).setProperties({ display: visible ? 'flex' : 'none' }); };
    // Horizon buttons paint their own hover/pressed theme layers above inline
    // colours, so a clicked chip would keep the dark pressed fill. Resolve the
    // same colour for every pointer state instead of only the resting one.
    const tintChip = (id: string, background: string): void => {
      const fill = { backgroundColor: background, hover: { backgroundColor: background }, active: { backgroundColor: background } };
      panel.requireElementById(id).setProperties(fill);
      panel.requireElementById(`${id}-label`).setProperties({ color: '#202124', hover: { color: '#202124' }, active: { color: '#202124' } });
    };
    const feedback = (text: string, error = false): void => {
      if (disposed) return;
      setText('workspace-feedback', text);
      panel.requireElementById('workspace-feedback').setProperties({ color: error ? '#a50e0e' : '#174ea6' });
    };
    const reportError = (error: unknown): void => feedback(error instanceof Error ? error.message : String(error), true);
    const changeDraft = (patch: Partial<AgentSettings>): void => {
      Object.assign(pending, patch);
      Object.assign(draft, patch);
    };
    const currentFields = (): SettingField[] => {
      if (tab === 'character') return CHARACTER_FIELDS;
      if (tab !== 'connections' || sub === 'transfer') return [];
      const fields = CONNECTION_FIELDS[sub];
      if (sub === 'llm') return fields;
      const provider = draft[sub === 'stt' ? 'sttProvider' : 'ttsProvider'];
      return fields.filter((field) => field.kind === 'provider' ||
        (provider !== 'off' && field.key === 'speechLanguage') ||
        (provider === 'browser' && field.key === 'ttsVoice') || provider === 'openai');
    };
    const visibleRecords = (): MemoryRecord[] => records.filter((record) => tab === 'chat' ? record.kind === 'chat' : record.kind !== 'chat');
    const refreshRoom = (): void => {
      setText('room-status', getRoomSummary());
    };
    const render = (): void => {
      if (disposed) return;
      const settings = agentState.getSettings();
      const fields = currentFields();
      const character = tab === 'character';
      const connection = tab === 'connections';
      const transfer = connection && sub === 'transfer';
      const history = tab === 'chat' || tab === 'memory';
      setText('workspace-title', `${settings.agentName} / ${TAB_LABELS[tab]}`);
      const motion = cue && (cue.emotion !== 'neutral' || cue.gesture !== 'none') ? ` / ${cue.emotion} / ${cue.gesture}` : '';
      setText('workspace-status', `${Object.keys(pending).length ? 'Unsaved changes / ' : ''}${agentBrain.mode === 'live' ? `LLM: ${settings.modelId}` : 'Offline demo / no authenticated LLM'}${motion}`);
      for (const key of Object.keys(TAB_LABELS) as WorkspaceTab[]) tintChip(`nav-${key}`, tab === key ? '#d2e3fc' : '#f1f3f4');
      for (const key of Object.keys(SUB_LABELS) as ConnectionTab[]) tintChip(`sub-${key}`, sub === key ? '#d2e3fc' : '#f1f3f4');
      show('connection-tabs', connection);
      show('camera-status', tab === 'chat');
      show('room-status', tab === 'chat');
      setText('camera-status', cameraStatus);
      refreshRoom();
      let body = '';
      if (history) {
        const items = visibleRecords();
        page = Math.min(page, Math.max(0, items.length - 1));
        const record = items[page];
        body = record ? `${record.kind === 'chat' ? record.role === 'user' ? 'You' : settings.agentName : record.kind.toUpperCase()}\n${record.text}` : tab === 'chat' ? 'Write a message, use the microphone, or explicitly request Look / camera. Camera frames are never captured in the background.' : search ? `No saved notes/facts matching: ${search}` : 'No saved facts or notes. Add a note or let the agent save a fact during dialogue.';
        setText('workspace-page', `${items.length ? page + 1 : 0} / ${items.length}${search && tab === 'memory' ? ' / search' : ''}`);
      } else if (character) {
        const status = getCharacterStatus();
        body = `${draft.characterVrmUrl ? 'Custom VRM' : BUNDLED_CHARACTER_PRESET.modelName}\n${status.error || (status.ready ? 'Avatar ready in the shared scene.' : 'Loading avatar...')}\nPreset restores the bundled character. Select any field to edit; Save applies your draft.`;
      } else if (transfer) {
        body = receivingUrl ? 'Encrypted settings received. Enter the 6-digit PIN from the sending device, then Apply settings. The link expires after 10 minutes. Skip discards this link without changing your settings.' : 'Encrypted settings transfer. Save settings first, generate a QR, then scan/open its link on the receiver and enter the PIN. QR + PIN together are secret. Expires after 10 minutes. No memory or dialogue is transferred.';
      } else {
        body = sub === 'llm' ? 'Independent LLM endpoint, model and key. Free preset selects NVIDIA Nemotron 3 Nano Omni free on OpenRouter via the shared pool (verified here with text + image vision). Gemma 4 31B free exists, but returned pooled-provider 429s during verification. The multi-tool model id still resolves through OpenRouter; your key is never bundled.' : sub === 'stt' ? 'Independent speech recognition. Browser engine requires runtime support; OpenAI-compatible STT records only while active. Test records and displays a transcript without sending it to the LLM.' : 'Independent speech output. Browser voices depend on this runtime. Fish free preset uses the OpenAI-compatible audio/speech endpoint. Copy LLM key to TTS is an explicit separate action.';
      }
      setText('workspace-body', body);
      show('record-navigation', history && !editing);
      show('workspace-fields', fields.length > 0 && !editing);
      for (let index = 0; index < 6; index++) {
        const field = fields[index];
        show(`field-${index}`, Boolean(field));
        if (!field) continue;
        const value = draft[field.key];
        const label = field.kind === 'secret' ? value ? 'Stored (hidden); blank retains' : 'Not set' : field.kind === 'toggle' ? value ? 'On' : 'Off' : field.kind === 'provider' ? PROVIDER_LABELS[String(value)] : String(value || 'Not set');
        const text = `${field.label}: ${label}`;
        // Field rows are one line high: truncate the assembled label (prefix
        // included) so it cannot wrap into a second, clipped line.
        setText(`field-label-${index}`, text.length > 62 ? `${text.slice(0, 59)}...` : text);
      }
      show('chat-actions', tab === 'chat' && !editing);
      show('settings-actions', fields.length > 0 && !editing);
      show('workspace-test', connection && !transfer);
      setText('workspace-test-label', sub === 'stt' && capture ? 'Stop test' : `Test ${sub.toUpperCase()}`);
      show('workspace-clear-key', fields.some((field) => field.kind === 'secret'));
      show('workspace-preset', character);
      show('connection-actions', connection && !transfer && !editing && (sub === 'llm' || sub === 'tts'));
      show('workspace-free-preset', sub === 'llm');
      show('workspace-copy-key', sub === 'tts');
      show('workspace-browser-voice', sub === 'tts' && draft.ttsProvider === 'browser');
      show('memory-actions', tab === 'memory' && !editing);
      setText('workspace-clear-label', confirmingClear ? 'Confirm clear' : 'Clear all');
      show('transfer-actions', transfer && !receivingUrl && !editing);
      show('receiver-actions', transfer && Boolean(receivingUrl) && !editing);
      setText('workspace-receiver-pin-label', receivingPin ? 'PIN entered (hidden)' : 'Enter receiver PIN');
      show('transfer-image', transfer && !receivingUrl && pairing != null);
      if (pairing) setText('pairing-pin', `PIN: ${pairing.pin}\nOpen link on receiver. Valid for 10 minutes. Treat QR + PIN as a secret.`);
      show('workspace-editor', editing != null);
      setText('workspace-listen-label', microphoneStarting ? 'Starting...' : capture ? 'Stop recording' : 'Microphone');
      show('workspace-enter-mr', !world.session && supportsMR);
      show('workspace-enter-vr', !world.session && supportsVR);
      show('workspace-exit', Boolean(world.session));
    };
    const save = async (): Promise<boolean> => {
      try {
        const patch = { ...pending };
        await agentState.updateSettings(patch);
        if (disposed) return false;
        for (const key of Object.keys(patch) as (keyof AgentSettings)[]) {
          if (pending[key] === patch[key]) delete pending[key];
        }
        draft = { ...agentState.getSettings(), ...pending };
        feedback('Saved on this device.'); render(); return true;
      } catch (error) { reportError(error); return false; }
    };
    const submit = (text: string): void => {
      if (disposed || !text.trim() || busy) return;
      busy = true; feedback('Thinking...');
      void agentBrain.send(text.trim()).then(() => feedback('')).catch(reportError).finally(() => { busy = false; if (!disposed) render(); });
    };
    const microphone = (test = false): void => {
      if (capture) { capture.stop(); feedback('Finishing recording...'); return; }
      if (microphoneStarting) return;
      microphoneStarting = true; render();
      void startListening((text) => {
        if (disposed) return;
        capture = null;
        feedback(text ? test ? `STT transcript: ${text}` : 'Transcript received.' : 'No speech detected.');
        if (!test) submit(text);
        render();
      }, (status) => {
        if (disposed) return;
        feedback(status);
        if (/stopped|error|failed|denied|unsupported|unavailable|cancel|complete|No speech|disabled/i.test(status)) capture = null;
        render();
      }).then((session) => {
        if (disposed) { session.cancel(); return; }
        capture = session.active ? session : null;
      }).catch(reportError).finally(() => { microphoneStarting = false; if (!disposed) render(); });
    };
    const updateEditorPreview = (): void => {
      const secret = editing === 'pin' || (typeof editing === 'object' && editing?.kind === 'secret');
      setText('workspace-editor-value', secret ? input.value ? editing === 'pin' ? 'PIN entered (hidden)' : 'Replacement key entered (hidden)' : editing === 'pin' ? 'Enter the 6-digit PIN from the sender.' : 'Blank retains stored key. Use Clear key to remove it.' : input.value.slice(-180) || 'Type with your keyboard. Enter = Done; Shift+Enter = newline.');
    };
    const closeEditor = (commit: boolean): void => {
      const target = editing;
      if (!target) return;
      if (commit && composing) return;
      const value = typeof target === 'object' && target.kind === 'secret' ? input.value.trim() : input.value;
      if (commit && target === 'chat' && busy) { feedback('Wait for the current reply before sending.', true); return; }
      if (commit && typeof target === 'object' && target.kind === 'number') {
        const number = Number(value);
        if (!value.trim() || !Number.isFinite(number) || number < 0.5 || number > 2) { feedback('Avatar scale must be between 0.5 and 2.', true); return; }
      }
      editing = null;
      input.value = ''; input.blur(); bridge.hidden = true;
      if (commit) {
        if (target === 'chat') submit(value);
        else if (target === 'note') { if (value.trim()) void agentState.addMemory(value, 'note').then(() => feedback('Note saved on this device.')).catch(reportError); }
        else if (target === 'search') { search = value.trim(); page = 0; refreshRecords(); }
        else if (target === 'pin') { receivingPin = value.replace(/\D/gu, '').slice(0, 6); feedback(receivingPin.length === 6 ? 'PIN ready. Press Apply settings.' : 'Enter all 6 PIN digits.', receivingPin.length !== 6); }
        else if (target.kind !== 'secret' || value !== '') changeDraft({ [target.key]: target.kind === 'number' ? Number(value) : value });
      }
      render();
    };
    const focusEditor = (): void => {
      if (!editing) return;
      const session = world.session as (XRSession & { isSystemKeyboardSupported?: boolean }) | null;
      if (session?.isSystemKeyboardSupported === false) {
        feedback('This immersive browser does not support the system keyboard. Use browser mode or encrypted QR transfer.', true);
        return;
      }
      input.focus();
    };
    const edit = (target: EditorTarget): void => {
      if (editing) closeEditor(true);
      if (editing) return;
      if (typeof target === 'object' && target.kind === 'toggle') { changeDraft({ [target.key]: !draft[target.key] }); render(); return; }
      if (typeof target === 'object' && target.kind === 'provider') {
        const values = ['off', 'browser', 'openai'];
        const next = values[(values.indexOf(String(draft[target.key])) + 1) % values.length];
        changeDraft({ [target.key]: next });
        if (target.key === 'ttsProvider' && next === 'browser') changeDraft({ ttsVoice: '' });
        render(); return;
      }
      editing = target;
      const secret = target === 'pin' || (typeof target === 'object' && target.kind === 'secret');
      input = secret ? secretInput : textInput;
      input.inputMode = target === 'pin' ? 'numeric' : 'text';
      secretInput.hidden = !secret; textInput.hidden = secret;
      input.value = typeof target === 'object' ? secret ? '' : String(draft[target.key]) : target === 'search' ? search : '';
      const label = typeof target === 'object' ? target.label : target === 'chat' ? 'Message' : target === 'note' ? 'New memory note' : target === 'pin' ? 'Receiver PIN (6 digits)' : 'Search saved notes and facts';
      bridgeLabel.textContent = label;
      bridgeLabel.htmlFor = input.id;
      setText('workspace-editor-label', typeof target === 'object' ? `${label}${target.help ? ` / ${target.help}` : ''}` : label);
      bridge.hidden = false;
      updateEditorPreview(); render(); focusEditor(); input.select();
    };
    const refreshRecords = (): void => {
      const generation = ++recordGeneration;
      const result = search && tab === 'memory' ? agentState.searchMemories(search, Number.MAX_SAFE_INTEGER) : agentState.recentMemories(Number.MAX_SAFE_INTEGER);
      void result.then((next) => { if (disposed || generation !== recordGeneration) return; records = next; render(); }).catch(reportError);
    };
    const selectTab = (next: WorkspaceTab): void => {
      closeEditor(true);
      if (editing) return;
      tab = next; page = 0; confirmingClear = false; refreshRecords(); render();
    };
    const action = (id: string, callback: () => void): void => {
      const element = panel.requireElementById(id);
      element.name = id;
      element.addEventListener('click', callback);
      disposers.push(() => element.removeEventListener('click', callback));
    };
    for (const key of Object.keys(TAB_LABELS) as WorkspaceTab[]) action(`nav-${key}`, () => selectTab(key));
    for (const key of Object.keys(SUB_LABELS) as ConnectionTab[]) action(`sub-${key}`, () => { closeEditor(true); if (editing) return; sub = key; render(); });
    for (let index = 0; index < 6; index++) action(`field-${index}`, () => { const field = currentFields()[index]; if (field) edit(field); });
    action('workspace-edit-chat', () => edit('chat'));
    action('workspace-look', () => submit('Look at this'));
    action('workspace-listen', () => microphone());
    action('workspace-save', () => { closeEditor(true); if (!editing) void save(); });
    action('workspace-test', () => {
      const provider = sub;
      if (provider === 'stt' && capture) { microphone(true); return; }
      void save().then((saved) => {
        if (!saved || disposed) return;
        if (provider === 'llm') {
          if (agentBrain.mode !== 'live') { feedback('No live LLM configured. Set an endpoint, model and key before testing.', true); return; }
          submit('Connection test: please reply with a short greeting.');
        } else if (provider === 'stt') microphone(true);
        else if (provider === 'tts') void speak('Hello. This is a test of your selected voice provider.').catch(reportError);
      });
    });
    action('workspace-clear-key', () => {
      closeEditor(false);
      const field = currentFields().find((item) => item.kind === 'secret');
      if (field) { changeDraft({ [field.key]: '' }); feedback('Key explicitly removed from draft. Save to apply.'); render(); }
    });
    action('workspace-preset', () => { changeDraft({ characterVrmUrl: '', characterScale: 1 }); feedback('Bundled character selected in draft. Save to apply.'); render(); });
    action('workspace-free-preset', () => {
      changeDraft(OPENROUTER_FREE_PRESET);
      feedback('Free model/voice preset in draft. LLM and TTS keys remain separate and unchanged. Save to apply.'); render();
    });
    action('workspace-copy-key', () => {
      if (!draft.modelApiKey) { feedback('Set an LLM key first. The TTS key was not changed.', true); return; }
      changeDraft({ ttsApiKey: draft.modelApiKey });
      feedback('LLM key explicitly copied to TTS draft. Save to apply.'); render();
    });
    action('workspace-browser-voice', () => {
      const voices = window.speechSynthesis?.getVoices() ?? [];
      if (!voices.length) { feedback('This runtime exposes no browser voices. Try again after voices load, or choose a speech provider.', true); return; }
      const index = voices.findIndex((voice) => voice.voiceURI === draft.ttsVoice);
      const voice = voices[(index + 1) % voices.length];
      if (!voice) return;
      changeDraft({ ttsVoice: voice.voiceURI });
      feedback(`Browser voice: ${voice.name} / ${voice.lang}. Save to apply.`); render();
    });
    action('workspace-memory-add', () => edit('note'));
    action('workspace-memory-search', () => edit('search'));
    action('workspace-memory-reset', () => { search = ''; page = 0; refreshRecords(); });
    action('workspace-memory-clear', () => {
      if (!confirmingClear) { confirmingClear = true; feedback('This permanently clears ALL dialogue, facts and notes. Press Confirm clear again, or change tab to cancel.', true); render(); return; }
      confirmingClear = false; search = ''; page = 0;
      // The panel is not the only place that remembers: drop model history and stop speech too.
      agentBrain.resetConversation();
      hush();
      void agentState.clearMemories().then(() => feedback('All dialogue, facts and notes cleared on this device, and the model dialogue reset.')).catch(reportError); render();
    });
    action('workspace-previous', () => { page = Math.max(0, page - 1); render(); });
    action('workspace-next', () => { page = Math.min(Math.max(0, visibleRecords().length - 1), page + 1); render(); });
    action('workspace-editor-focus', focusEditor);
    action('workspace-editor-done', () => closeEditor(true));
    action('workspace-editor-cancel', () => closeEditor(false));
    action('workspace-transfer', () => {
      if (pairingBusy) return;
      if (Object.keys(pending).length) { feedback('Save your draft before generating a settings transfer.', true); return; }
      const generation = ++pairingGeneration;
      pairingBusy = true; feedback('Encrypting settings...');
      void createPairingOffer(agentState.getSettings()).then((offer) => {
        if (disposed || generation !== pairingGeneration) return;
        pairing = offer;
        const qr = qrcode(0, 'M'); qr.addData(offer.url); qr.make();
        panel.requireElementById('pairing-qr').setProperties({ src: qr.createDataURL(5, 20) });
        clearTimeout(pairingTimer);
        pairingTimer = setTimeout(() => {
          pairing = null;
          setText('pairing-pin', '');
          panel.requireElementById('pairing-qr').setProperties({ src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' });
          feedback('QR display expired. Generate another offer.'); render();
        }, Math.max(0, offer.expiresAt - Date.now()));
        feedback('Scan the encrypted QR and enter the PIN on the receiving browser.'); render();
      }).catch(reportError).finally(() => { pairingBusy = false; });
    });
    action('workspace-copy-link', () => {
      if (!pairing || pairing.expiresAt <= Date.now()) { feedback('Generate a valid QR offer first.', true); return; }
      if (!navigator.clipboard?.writeText) { feedback('Clipboard unavailable in this browser. Scan the QR instead.', true); return; }
      void navigator.clipboard.writeText(pairing.url).then(() => feedback('Encrypted pairing link copied. Enter its PIN on the receiving browser.')).catch(() => feedback('Clipboard denied. Scan the QR instead.', true));
    });
    const discardReceiver = (): void => {
      receivingUrl = ''; receivingPin = '';
      if (parsePairingFragment(location.hash)) history.replaceState(null, '', location.pathname + location.search);
      render();
    };
    // Opening a pairing link in a tab where this app is already running is a
    // same-document hash navigation: no reload happens, so the fragment must be
    // picked up here or the panel would keep the previous link.
    const receivePairingUrl = (): void => {
      if (!parsePairingFragment(window.location.hash)) return;
      receivingUrl = window.location.href;
      receivingPin = ''; receivingBusy = false;
      editing = null; input.value = ''; input.blur(); bridge.hidden = true;
      tab = 'connections'; sub = 'transfer'; page = 0; confirmingClear = false;
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      feedback('Pairing link received. Enter the 6-digit PIN, then Apply settings.');
      render();
    };
    window.addEventListener('hashchange', receivePairingUrl);
    disposers.push(() => window.removeEventListener('hashchange', receivePairingUrl));
    action('workspace-receiver-pin', () => edit('pin'));
    action('workspace-receiver-apply', () => {
      if (receivingBusy) return;
      if (!receivingUrl || receivingPin.length !== 6) { feedback('Enter all 6 PIN digits first.', true); return; }
      receivingBusy = true; feedback('Decrypting settings...');
      void consumePairingUrl(receivingUrl, receivingPin).then((patch) => {
        if (disposed) return;
        return agentState.updateSettings(patch);
      }).then(() => {
        if (disposed) return;
        draft = { ...agentState.getSettings(), ...pending };
        discardReceiver();
        feedback('Settings applied to this browser. Any existing unsaved draft is retained.');
      }).catch(reportError).finally(() => { receivingBusy = false; });
    });
    action('workspace-receiver-skip', () => { closeEditor(false); discardReceiver(); feedback('Pairing link discarded. Current settings unchanged.'); });
    action('workspace-enter-mr', () => { world.launchXR({ sessionMode: SessionMode.ImmersiveAR }); });
    action('workspace-enter-vr', () => { world.launchXR({ sessionMode: SessionMode.ImmersiveVR, features: { anchors: false, hitTest: false, planeDetection: false, meshDetection: false } }); });
    action('workspace-exit', () => world.exitXR());

    const keyboardDown = (event: Event): void => {
      if (!(event instanceof KeyboardEvent)) return;
      event.stopPropagation();
      if (event.isComposing || composing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); closeEditor(true); }
      else if (event.key === 'Escape') { event.preventDefault(); closeEditor(false); }
    };
    const stopKeys = (event: Event): void => event.stopPropagation();
    const startComposition = (): void => { composing = true; };
    let canvasPointerActive = false;
    const canvasPointerDown = (): void => { canvasPointerActive = true; };
    const canvasPointerUp = (): void => { canvasPointerActive = false; };
    const finishComposition = (): void => {
      composing = false; updateEditorPreview();
      if (world.session && document.activeElement !== input && !canvasPointerActive) closeEditor(true);
    };
    // A canvas click must reach Done/Cancel before committing a blurred editor.
    // Native system-keyboard Done blurs without a canvas pointer and commits.
    const blurEditor = (): void => { if (world.session && !composing && !canvasPointerActive) closeEditor(true); };
    const canvas = world.renderer.domElement;
    canvas.addEventListener('pointerdown', canvasPointerDown, true);
    window.addEventListener('pointerup', canvasPointerUp, true);
    window.addEventListener('pointercancel', canvasPointerUp, true);
    disposers.push(() => {
      canvas.removeEventListener('pointerdown', canvasPointerDown, true);
      window.removeEventListener('pointerup', canvasPointerUp, true);
      window.removeEventListener('pointercancel', canvasPointerUp, true);
    });
    for (const editor of [textInput, secretInput]) {
      editor.addEventListener('keydown', keyboardDown); editor.addEventListener('keyup', stopKeys);
      editor.addEventListener('input', updateEditorPreview); editor.addEventListener('compositionstart', startComposition);
      editor.addEventListener('compositionend', finishComposition); editor.addEventListener('blur', blurEditor);
      disposers.push(() => {
        editor.removeEventListener('keydown', keyboardDown); editor.removeEventListener('keyup', stopKeys);
        editor.removeEventListener('input', updateEditorPreview); editor.removeEventListener('compositionstart', startComposition);
        editor.removeEventListener('compositionend', finishComposition); editor.removeEventListener('blur', blurEditor);
      });
    }
    const resize = (): void => {
      const width = Math.min(480, window.innerWidth - 24);
      const height = Math.min(720, window.innerHeight - 24);
      panelEntity.setValue(ScreenSpace, 'width', `${width}px`);
      panelEntity.setValue(ScreenSpace, 'height', `${height}px`);
    };
    panelEntity.addComponent(ScreenSpace, { width: '480px', height: '720px', top: '12px', right: '12px', zOffset: 0.4 });
    resize();
    window.addEventListener('resize', resize);
    const updateMode = (state: VisibilityState): void => {
      const immersive = state !== VisibilityState.NonImmersive;
      document.body.classList.toggle('workspace-immersive', immersive);
      panelEntity.setValue(Visibility, 'isVisible', true);
      const space = world.getSceneObject('vr-space');
      if (space) space.visible = !immersive || world.session?.environmentBlendMode === 'opaque';
      render();
    };
    if (navigator.xr && world.xrEnabled) {
      void Promise.all([navigator.xr.isSessionSupported('immersive-ar'), navigator.xr.isSessionSupported('immersive-vr')]).then(([mr, vr]) => {
        if (disposed) return; supportsMR = mr; supportsVR = vr; render();
        if (!mr && !vr) feedback('This browser has no immersive MR/VR support. Desktop controls remain available.');
      }).catch(() => feedback('Immersive capability check unavailable. Desktop controls remain available.'));
    } else {
      feedback('Immersive MR/VR is unavailable in this browser. Desktop controls remain available.');
    }
    disposers.push(agentState.onSettingsChanged((settings) => { draft = { ...settings, ...pending }; render(); }));
    disposers.push(agentState.onMemoriesChanged(refreshRecords));
    disposers.push(world.visibilityState.subscribe(updateMode));
    disposers.push(onSpeechStatus((status) => feedback(status)));
    disposers.push(onCharacterStatus(() => render()));
    disposers.push(onAvatarCue((next) => { cue = next; render(); }));
    disposers.push(onPerceptionStatus((status) => { cameraStatus = status; render(); }));
    void agentState.ready.then(() => { if (disposed) return; draft = { ...agentState.getSettings(), ...pending }; refreshRecords(); render(); });
    render(); updateMode(world.visibilityState.value);
    if (getSpeechStatus()) feedback(getSpeechStatus());
    this.cleanupFuncs.push(() => {
      disposed = true; editing = null; input.blur();
      cancelListening(); capture?.cancel();
      clearTimeout(pairingTimer); pairingGeneration++; recordGeneration++;
      window.removeEventListener('resize', resize);
      for (const dispose of disposers) dispose();
      document.body.classList.remove('workspace-immersive');
      bridge.remove();
    });
  }
}
