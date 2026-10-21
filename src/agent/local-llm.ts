import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  WebWorkerMLCEngine,
} from '@mlc-ai/web-llm';

/** Plain OpenAI-style history; the local preset deliberately has no tools. */
export interface LocalLlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

let engine: WebWorkerMLCEngine | null = null;
let worker: Worker | null = null;
let loadedModel = '';
let loading: Promise<WebWorkerMLCEngine> | null = null;
let status = '';
const listeners = new Set<(status: string) => void>();

function setStatus(next: string): void {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener(next);
}

export function getLocalLlmStatus(): string {
  return status;
}

/** Subscribe to model download/compile progress; also report the current text. */
export function onLocalLlmStatus(callback: (status: string) => void): () => void {
  listeners.add(callback);
  callback(status);
  return () => { listeners.delete(callback); };
}

type GpuNavigator = Navigator & {
  gpu?: { requestAdapter(): Promise<unknown | null> };
};

/**
 * Gemma 3 uses a sliding window. WebLLM refuses a model whose context window
 * and sliding window are both positive, so the context window is disabled.
 */
const MODEL_OVERRIDES: Record<string, Record<string, number>> = {
  'gemma3-1b-it-q4f16_1-MLC': { context_window_size: -1, attention_sink_size: 0 },
};

async function assertWebGpu(): Promise<void> {
  const gpu = typeof navigator === 'undefined' ? undefined : (navigator as GpuNavigator).gpu;
  if (!gpu) {
    throw new Error('Full local mode needs WebGPU. Use a desktop Chrome/Edge build with WebGPU enabled, or choose a free or paid API preset.');
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error('WebGPU is present but no GPU adapter is available. Close other GPU-heavy tabs, disable software rendering, or choose an API preset.');
  }
}

function createWorker(): Worker {
  return new Worker(new URL('./local-llm.worker.ts', import.meta.url), { type: 'module' });
}

async function ensureEngine(modelId: string): Promise<WebWorkerMLCEngine> {
  if (engine && loadedModel === modelId) return engine;
  if (loading) {
    await loading;
    return ensureEngine(modelId);
  }
  loading = (async () => {
    await assertWebGpu();
    const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await import('@mlc-ai/web-llm');
    const overrides = MODEL_OVERRIDES[modelId];
    const modelList = overrides
      ? prebuiltAppConfig.model_list.map((record) => record.model_id === modelId
        ? { ...record, overrides: { ...record.overrides, ...overrides } }
        : record)
      : prebuiltAppConfig.model_list;
    if (!engine) {
      worker = createWorker();
      engine = await CreateWebWorkerMLCEngine(worker, modelId, {
        // The Cache API cannot store Hugging Face's Xet CDN responses
        // (Cache.add() rejects them), so the model is cached in IndexedDB.
        appConfig: { ...prebuiltAppConfig, model_list: modelList, cacheBackend: 'indexeddb' },
        initProgressCallback: ({ text }) => setStatus(text),
      });
    } else {
      setStatus(`Loading ${modelId}...`);
      await engine.reload(modelId);
    }
    loadedModel = modelId;
    setStatus('');
    return engine;
  })().finally(() => { loading = null; });
  return loading;
}

/**
 * Run one text-only turn in the WebLLM worker. Throws actionable errors as-is;
 * the brain does not invent a reply when WebGPU or the model is unavailable.
 */
export async function completeLocalLlm(
  messages: LocalLlmMessage[],
  modelId: string,
  signal: AbortSignal,
): Promise<string> {
  const active = await ensureEngine(modelId);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  const interrupt = (): void => { void active.interruptGenerate(); };
  signal.addEventListener('abort', interrupt, { once: true });
  try {
    const completion = await active.chat.completions.create({
      messages: messages as ChatCompletionMessageParam[],
      stream: true,
      temperature: 0.7,
      max_tokens: 512,
    });
    let reply = '';
    for await (const chunk of completion as AsyncIterable<ChatCompletionChunk>) {
      if (signal.aborted) break;
      reply += chunk.choices[0]?.delta?.content ?? '';
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return reply;
  } finally {
    signal.removeEventListener('abort', interrupt);
  }
}

/** Release the WebGPU worker (used when the user changes away from local mode). */
export async function unloadLocalLlm(): Promise<void> {
  const current = engine;
  engine = null;
  loadedModel = '';
  setStatus('');
  try {
    await current?.unload();
  } catch {
    // The worker is terminated below regardless of backend state.
  }
  worker?.terminate();
  worker = null;
}
