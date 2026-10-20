import { z } from 'zod';
import type { AgentSettings } from './contracts.js';
export const agentSettingsSchema = z.object({
  agentName: z.string().min(1),
  idleMotion: z.boolean(),
  gazeTracking: z.boolean(),
  modelEndpoint: z.string(),
  modelId: z.string(),
  modelApiKey: z.string(),
  characterVrmUrl: z.string(),
  characterPrompt: z.string(),
  characterScale: z.number().min(0.5).max(2),
  speechLanguage: z.string().min(2),
  ttsProvider: z.enum(['off', 'browser', 'openai']),
  ttsEndpoint: z.string(),
  ttsModel: z.string(),
  ttsVoice: z.string(),
  ttsApiKey: z.string(),
  sttProvider: z.enum(['off', 'browser', 'openai']),
  sttEndpoint: z.string(),
  sttModel: z.string(),
  sttApiKey: z.string(),
});

/** Public model selection only. Credentials are never included or copied. */
export const OPENROUTER_FREE_PRESET = {
  modelEndpoint: 'https://openrouter.ai/api/v1',
  modelId: 'google/gemma-4-31b-it:free',
  ttsProvider: 'openai',
  ttsEndpoint: 'https://openrouter.ai/api/v1',
  ttsModel: 'fish-audio/s2.1-pro-free:free',
  ttsVoice: 'b347db033a6549378b48d00acb0d06cd',
} as const satisfies Partial<AgentSettings>;

export const DEFAULT_SETTINGS: AgentSettings = {
  agentName: 'Ava',
  idleMotion: true,
  gazeTracking: true,
  modelEndpoint: OPENROUTER_FREE_PRESET.modelEndpoint,
  modelId: OPENROUTER_FREE_PRESET.modelId,
  modelApiKey: '',
  characterVrmUrl: '',
  characterPrompt: 'You are Ava, a thoughtful, curious companion. Reply in the language the user speaks. Be concise and honest about what you know.',
  characterScale: 1,
  speechLanguage: 'ru-RU',
  ttsProvider: 'off',
  ttsEndpoint: OPENROUTER_FREE_PRESET.ttsEndpoint,
  ttsModel: OPENROUTER_FREE_PRESET.ttsModel,
  ttsVoice: OPENROUTER_FREE_PRESET.ttsVoice,
  ttsApiKey: '',
  sttProvider: 'off',
  sttEndpoint: '',
  sttModel: '',
  sttApiKey: '',
};
