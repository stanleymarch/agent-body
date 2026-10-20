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
import {
  buildCueTag,
  CueStreamFilter,
  pickOfflineCue,
  publishAvatarCue,
} from './cues.js';
import type { AvatarCue } from './contracts.js';

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
   * (driving the avatar's mouth), performs the reply's cue, persists the
   * assistant reply, and returns the full reply text with the cue tag
   * already stripped.
   */
  send(text: string): Promise<string>;
  /** 'live' when a model endpoint is configured, else scripted offline mode. */
  readonly mode: 'live' | 'scripted';
  /** True throughout sending, reply generation, and memory persistence. */
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
    const cue = pickOfflineCue(text);
    const reply = `${buildCueTag(cue)}${settings.agentName} (offline brain): I heard "${text}". Configure a model endpoint in settings to give me a real mind.${memoryLine}`;
    avatarBody.playCue(cue);
    publishAvatarCue(cue);
    avatarBody.setTalking(true);
    // Same tag path as the live stream: mouth, memory and UI never see the tag.
    const filter = new CueStreamFilter();
    for (const word of reply.split(/(\s+)/u)) {
      const visible = filter.push(word);
      if (visible.length > 0) avatarBody.speakChunk(visible);
      const { promise: tick, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, CHUNK_DELAY_MS);
      await tick;
    }
    const tail = filter.end();
    if (tail.length > 0) avatarBody.speakChunk(tail);
    return filter.text;
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
    // Guard before the first await, including offline replies and DB writes.
    this.streaming = true;
    // Clear the previous turn's badge before the new cue arrives.
    publishAvatarCue(null);
    try {
      hush();
      await agentState.addMemory(trimmed, 'chat', 'user');
      const reply = this.mode === 'scripted'
        ? await new ScriptedBrain().send(trimmed)
        : await this.sendLive(trimmed);
      if (reply.length > 0) {
        await agentState.addMemory(reply, 'chat', 'assistant');
        // Speech failures are published by onSpeechStatus. Do not lose the
        // completed text reply or leave an unhandled background rejection.
        void speak(reply).catch(() => {
          // The speech module has already notified its diagnostic subscribers.
        });
      }
      this.remember('user', trimmed);
      this.remember('assistant', reply);
      return reply;
    } finally {
      avatarBody.setTalking(false);
      this.streaming = false;
    }
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
        ? recalled.map((m) => m.text).join('\n')
        : '(no relevant memories)';
    const system = [
      `You are ${settings.agentName}, an embodied agent living in the user's mixed-reality space.`,
      settings.characterPrompt,
      `Today is ${new Date().toISOString().slice(0, 10)}.`,
      'Keep replies short and conversational (1–3 sentences) unless asked for more.',
      "Begin every reply with exactly one performance tag [[emotion|gesture]] where emotion is one of neutral, happy, angry, sad, relaxed, surprised and gesture is one of none, wave, nod, shake, think, bow. Pick the tag that matches the reply's tone; it is stripped before anyone sees the text. Example: [[happy|wave]] Great to see you!",
      'Relevant long-term memories for this turn:',
      memoryBlock,
      'You can save important facts with memory_write and look up older memories with memory_search.',
    ].join('\n');

    avatarBody.setTalking(true);
    const filter = new CueStreamFilter();
    let cuePublished = false;
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
        const visible = filter.push(chunk);
        if (visible.length > 0) {
          full += visible;
          avatarBody.speakChunk(visible);
        }
        if (!cuePublished && filter.cue != null) {
          cuePublished = true;
          avatarBody.playCue(filter.cue);
          publishAvatarCue(filter.cue);
        }
      }
      const tail = filter.end();
      if (tail.length > 0) {
        full += tail;
        avatarBody.speakChunk(tail);
      }
      if (!cuePublished && filter.cue != null) {
        avatarBody.playCue(filter.cue);
        publishAvatarCue(filter.cue);
      }
    } catch {
      full =
        full.length > 0
          ? full
          : `${settings.agentName}: my model endpoint failed; check settings.modelEndpoint/modelId/key.`;
      const failed: AvatarCue = { emotion: 'sad', gesture: 'shake' };
      avatarBody.playCue(failed);
      publishAvatarCue(failed);
    } finally {
      avatarBody.setTalking(false);
      // The outer send() owns the busy guard through memory persistence.
    }
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
