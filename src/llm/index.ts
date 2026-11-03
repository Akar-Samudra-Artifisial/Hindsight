import { chat as forgeChat, list as forgeList, type Message, type ModelListResponse } from '@forge/llm';

/**
 * Thin wrapper around Forge LLM (no external API: the app stays Runs on Atlassian). Only call from queue consumers
 * (900 s timeout), never from UI resolvers.
 */

/** Preferred FAST model (candidate scoring, Sentinel). */
export const FAST_MODEL = 'claude-haiku-4-5-20251001';
/** Preferred STRONG model (keyword expansion, briefings). */
export const STRONG_MODEL = 'claude-sonnet-4-6';

export interface Models {
  fast: string;
  strong: string;
}

/** No Forge LLM model is available on this site. */
export class LlmUnavailableError extends Error {
  constructor() {
    super('No Forge LLM model available');
    this.name = 'LlmUnavailableError';
  }
}

/** The model answered, but not with a usable tool call. */
export class LlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmOutputError';
  }
}

function choose(active: readonly string[], preferred: string, prefix: string): string | null {
  if (active.includes(preferred)) return preferred;
  return active.find((m) => m.startsWith(prefix)) ?? null;
}

/**
 * Picks FAST and STRONG once per job from `list()`: the preferred model when active, else an active model of the same
 * family; FAST falls back to STRONG. When `list()` fails the preferred constants are used (logged as `llm list failed`).
 */
export async function pickModels(listModels: () => Promise<ModelListResponse> = forgeList): Promise<Models> {
  let response: ModelListResponse;
  try {
    response = await listModels();
  } catch (err) {
    console.warn('llm list failed', { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    return { fast: FAST_MODEL, strong: STRONG_MODEL };
  }
  const active = (response?.models ?? []).filter((m) => m && m.status === 'active' && typeof m.model === 'string').map((m) => m.model);
  const strong = choose(active, STRONG_MODEL, 'claude-sonnet');
  const fast = choose(active, FAST_MODEL, 'claude-haiku') ?? strong;
  if (!fast) throw new LlmUnavailableError();
  return { fast, strong: strong ?? fast };
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. Forge LLM does not enforce it, so callers validate the result. */
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * Forces the model to call `tool` and returns its (unvalidated) arguments. Throws `LlmOutputError` when there is no
 * tool call or the arguments are not a JSON object. Logs only the model, tool and token usage.
 */
export async function chatTool(model: string, messages: Message[], tool: ToolSpec, options: ChatOptions = {}): Promise<unknown> {
  const response = await forgeChat({
    model,
    messages,
    temperature: options.temperature ?? 0,
    max_completion_tokens: options.maxTokens ?? 4096,
    tools: [{ type: 'function', function: tool }],
    tool_choice: { type: 'function', function: { name: tool.name } },
  });
  console.info('llm usage', { model, tool: tool.name, usage: response.usage });
  const call = response.choices[0]?.message.tool_calls?.[0];
  if (!call) throw new LlmOutputError(`LLM did not call ${tool.name}`);
  // Typed as object, but the REST API returns a JSON string.
  const raw: unknown = call.function.arguments;
  let args: unknown = raw;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      throw new LlmOutputError(`LLM returned malformed JSON arguments for ${tool.name}`);
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new LlmOutputError(`LLM returned non-object arguments for ${tool.name}`);
  return args;
}

/** True for a Forge LLM 429. `ForgeLlmAPIError` (which carries `status`) is not exported, so read the field. */
export function isLlmRateLimited(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 429;
}
