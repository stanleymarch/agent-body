import type { AgentSettings } from './agent/contracts.js';

export type WorkspaceTab = 'chat' | 'character' | 'connections' | 'memory';
export type ConnectionTab = 'llm' | 'stt' | 'tts' | 'transfer';
export interface SettingField {
  key: keyof AgentSettings;
  label: string;
  kind?: 'secret' | 'number' | 'multiline' | 'toggle' | 'provider';
  placeholder?: string;
  help?: string;
}

export const CHARACTER_FIELDS: SettingField[] = [
  { key: 'agentName', label: 'Display name' },
  { key: 'characterPrompt', label: 'Character instructions', kind: 'multiline', help: 'Defines the personality and reply style sent to the language model.' },
  { key: 'characterVrmUrl', label: 'VRM source URL', placeholder: 'Empty = bundled Ava', help: 'A direct HTTPS .vrm URL with CORS enabled. Leave empty for the bundled preset.' },
  { key: 'characterScale', label: 'Avatar scale', kind: 'number', help: '0.5 to 2.0, relative to the original model.' },
  { key: 'idleMotion', label: 'Breathing and idle motion', kind: 'toggle' },
  { key: 'gazeTracking', label: 'Look at the viewer', kind: 'toggle' },
];

export const CONNECTION_FIELDS: Record<Exclude<ConnectionTab, 'transfer'>, SettingField[]> = {
  llm: [
    { key: 'modelEndpoint', label: 'LLM base URL', placeholder: 'https://api.openai.com/v1', help: 'OpenAI-compatible chat/completions base URL. Empty = offline demo, not a real model.' },
    { key: 'modelId', label: 'LLM model', placeholder: 'Model ID from your provider' },
    { key: 'modelApiKey', label: 'LLM API key', kind: 'secret' },
  ],
  stt: [
    { key: 'sttProvider', label: 'Speech recognition provider', kind: 'provider' },
    { key: 'sttEndpoint', label: 'STT base URL', placeholder: 'https://api.openai.com/v1', help: 'For OpenAI-compatible audio/transcriptions.' },
    { key: 'sttModel', label: 'STT model', placeholder: 'whisper-1' },
    { key: 'sttApiKey', label: 'STT API key', kind: 'secret' },
    { key: 'speechLanguage', label: 'Speech language', placeholder: 'ru-RU' },
  ],
  tts: [
    { key: 'ttsProvider', label: 'Speech synthesis provider', kind: 'provider' },
    { key: 'ttsEndpoint', label: 'TTS base URL', placeholder: 'https://api.openai.com/v1', help: 'For OpenAI-compatible audio/speech.' },
    { key: 'ttsModel', label: 'TTS model', placeholder: 'tts-1' },
    { key: 'ttsVoice', label: 'Voice', placeholder: 'alloy or browser voice URI' },
    { key: 'ttsApiKey', label: 'TTS API key', kind: 'secret' },
    { key: 'speechLanguage', label: 'Speech language', placeholder: 'ru-RU' },
  ],
};

export const PROVIDER_LABELS: Record<string, string> = {
  off: 'Disabled', browser: 'Browser engine', openai: 'OpenAI-compatible API',
};
