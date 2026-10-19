/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import { avatarBody } from '../avatar-body.js';
import { agentState } from './state.js';
import { hush, speak } from './tts.js';

const MAX_STEPS = 4;
const CHUNK_DELAY_MS = 24;
const HISTORY_LIMIT = 20;

const memoryWriteInputSchema = z.object({
  text: z.string().min(1).describe('The fact or note to remember'),
  kind: z.enum(['note', 'fact']).default('fact'),
});

const memorySearchInputSchema = z.object({
  query: z.string().min(1).describe('Free-text search query'),
});

export interface AgentBrain {
  /**
   * Send one user message. Persists it as a chat memory, streams the reply
   * (driving the avatar's mouth), persists the assistant reply, and returns
   * the full reply text.
   */
  send(text: string): Promise<string>;
  /** 'live' when a model endpoint is configured, else scripted offline mode. */
  readonly mode: 'live' | 'scripted';
  /** True while a reply is streaming. */
  readonly busy: boolean;
}

class ScriptedBrain {
  async send(text: string): Promise<string> {
    const settings = agentState.getSettings();
    const hits = await agentState.searchMemories(text, 3);
    const recalled = hits.filter((m) => m.text !== text);
    const memoryLine =
      recalled.length > 0
        ? ` The closest thing I remember is: "${recalled[0]!.text}".`
        : ' I have no memories close to that yet; add a note and I will remember.';
    const reply = `${settings.agentName} (offline brain): I heard "${text}". Configure a model endpoint in settings to give me a real mind.${memoryLine}`;
    avatarBody.setTalking(true);
    for (const word of reply.split(/(\s+)/u)) {
      avatarBody.speakChunk(word);
      const { promise: tick, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, CHUNK_DELAY_MS);
      await tick;
    }
    avatarBody.setTalking(false);
    speak(reply);
    return reply;
  }
}

class AgentBrainImpl implements AgentBrain {
  private streaming = false;
  /** Session-scoped chat context; long-term memory is retrieved per turn. */
  private readonly history: { role: 'user' | 'assistant'; content: string }[] =
    [];

  get mode(): 'live' | 'scripted' {
    const settings = agentState.getSettings();
    return settings.modelEndpoint.length > 0 && settings.modelId.length > 0
      ? 'live'
      : 'scripted';
  }

  get busy(): boolean {
    return this.streaming;
  }

  async send(text: string): Promise<string> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || this.streaming) {
      return '';
    }
    await agentState.addMemory(trimmed, 'chat');
    if (this.mode === 'scripted') {
      const reply = await new ScriptedBrain().send(trimmed);
      await agentState.addMemory(reply, 'chat');
      this.remember('user', trimmed);
      this.remember('assistant', reply);
      return reply;
    }
    return this.sendLive(trimmed);
  }

  private async sendLive(userText: string): Promise<string> {
    const settings = agentState.getSettings();
    const provider = createOpenAICompatible({
      name: 'agent-body-endpoint',
      baseURL: settings.modelEndpoint,
      apiKey: settings.modelApiKey.length > 0 ? settings.modelApiKey : 'none',
    });
    const model = provider.chatModel(settings.modelId);

    const recalled = await agentState.searchMemories(userText, 3);
    const memoryBlock =
      recalled.length > 0
        ? recalled.map((m) => `- ${m.text}`).join('\n')
        : '(no relevant memories)';
    const system = [
      `You are ${settings.agentName}, an embodied agent living in the user's mixed-reality space.`,
      `Today is ${new Date().toISOString().slice(0, 10)}.`,
      'Keep replies short and conversational (1–3 sentences) unless asked for more.',
      'Relevant long-term memories for this turn:',
      memoryBlock,
      'You can save important facts with memory_write and look up older memories with memory_search.',
    ].join('\n');

    this.streaming = true;
    hush();
    avatarBody.setTalking(true);
    let full = '';
    try {
      const result = streamText({
        model,
        system,
        messages: [...this.history, { role: 'user', content: userText }],
        stopWhen: stepCountIs(MAX_STEPS),
        tools: {
          memory_write: tool({
            description:
              'Persist an important fact or note to long-term memory.',
            inputSchema: memoryWriteInputSchema,
            execute: async ({ text: memo, kind }) => {
              const saved = await agentState.addMemory(
                memo,
                kind === 'fact' ? 'fact' : 'note',
              );
              return { id: saved.id ?? -1, saved: true };
            },
          }),
          memory_search: tool({
            description: 'Search older long-term memories by free-text query.',
            inputSchema: memorySearchInputSchema,
            execute: async ({ query }) => {
              const hits = await agentState.searchMemories(query, 5);
              return { results: hits.map((m) => m.text) };
            },
          }),
        },
      });
      for await (const chunk of result.textStream) {
        if (chunk.length === 0) {
          continue;
        }
        full += chunk;
        avatarBody.speakChunk(chunk);
      }
    } catch (error) {
      console.error(
        '[brain] live model failed; reply is an error notice',
        error,
      );
      full =
        full.length > 0
          ? full
          : `${settings.agentName}: my model endpoint failed; check settings.modelEndpoint/modelId/key.`;
    } finally {
      avatarBody.setTalking(false);
      this.streaming = false;
    }
    if (full.length > 0) {
      speak(full);
      await agentState.addMemory(full, 'chat');
    }
    this.remember('user', userText);
    this.remember('assistant', full);
    return full;
  }

  private remember(role: 'user' | 'assistant', content: string): void {
    this.history.push({ role, content });
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
  }
}

export const agentBrain: AgentBrain = new AgentBrainImpl();
