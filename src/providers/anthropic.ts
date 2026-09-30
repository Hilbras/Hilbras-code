import type {
  ChatRequest,
  ChatResponse,
  FinishReason,
  Message,
  Provider,
  StreamEvent,
  ToolCall,
  Usage,
} from "../types.ts";
import { assertNonEmpty, jsonRequest, normaliseToolCallId, sseStream } from "./http.ts";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * Anthropic Messages API.
 *
 * The wire format differs from our normalised `Message` in two ways that
 * matter: system is a top-level parameter rather than a message, and tool
 * results are `user` turns carrying `tool_result` blocks. Both are converted
 * here so the agent loop stays provider-agnostic.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly supportsStreaming = true;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string = API_URL,
  ) {}

  async listModels(): Promise<string[]> {
    const data = await jsonRequest<{ data?: { id?: string }[] }>({
      url: `${this.baseUrl.replace(/\/messages$/, "")}/models?limit=100`,
      method: "GET",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
    });
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string")
      .sort();
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    assertNonEmpty(request);
    const payload = this.toWire(request);
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Anthropic ${response.status}: ${text.slice(0, 2000)}`);
    }
    return fromWire(JSON.parse(text) as AnthropicResponse);
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    assertNonEmpty(request);
    const payload = { ...this.toWire(request), stream: true };
    const toolCalls: ToolCall[] = [];
    let usage: Usage = emptyUsage();
    let finish: FinishReason = "stop";
    // Text is not accumulated here: the agent loop reassembles it from the
    // per-delta events, so holding a second copy here would only waste memory
    // on long completions.

    try {
      for await (const frame of sseStream({
        url: this.baseUrl,
        headers: this.headers(),
        body: payload,
      })) {
        const parsed = safeParse(frame.data) as AnthropicStreamEvent | null;
        if (!parsed) continue;

        switch (parsed.type) {
          case "content_block_start": {
            const block = parsed.content_block;
            if (block?.type === "tool_use") {
              toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: "" });
            }
            break;
          }
          case "content_block_delta": {
            const delta = parsed.delta;
            if (delta?.type === "text_delta") {
              yield { type: "text", text: delta.text ?? "" };
            } else if (delta?.type === "input_json_delta") {
              const current = toolCalls[parsed.index ?? 0];
              if (current) current.arguments += delta.partial_json ?? "";
            } else if (delta?.type === "thinking_delta") {
              yield { type: "reasoning", text: delta.thinking ?? "" };
            }
            break;
          }
          case "message_delta": {
            const deltaUsage = parsed.usage;
            if (deltaUsage) usage = mergeUsage(usage, deltaUsage);
            if (parsed.delta?.stop_reason) finish = mapStopReason(parsed.delta.stop_reason);
            break;
          }
          case "message_start": {
            const startUsage = (parsed.message as AnthropicResponse | undefined)?.usage;
            if (startUsage) usage = mergeUsage(usage, startUsage);
            break;
          }
          case "error": {
            yield { type: "error", error: parsed.error?.error?.message ?? "stream error" };
            finish = "error";
            break;
          }
          default:
            break;
        }
      }

      // Tool calls are surfaced before `done` so a consumer can act on them in
      // event order; the agent loop collects them all regardless.
      for (const call of toolCalls) yield { type: "toolCall", call };
      if (usage.totalTokens > 0) yield { type: "usage", usage };
      yield { type: "done", reason: finish };
    } catch (error) {
      yield { type: "error", error: errorMessage(error) };
      yield { type: "done", reason: "error" };
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "anthropic-version": API_VERSION,
    };
    if (this.apiKey.startsWith("sk-ant-oat")) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private toWire(request: ChatRequest): Record<string, unknown> {
    const systemParts: string[] = [];
    const messages: Record<string, unknown>[] = [];

    for (const message of request.messages) {
      if (message.role === "system") {
        systemParts.push(message.content);
        continue;
      }
      if (message.role === "user") {
        messages.push({ role: "user", content: message.content });
        continue;
      }
      if (message.role === "tool") {
        // Anthropic requires tool results as a user turn with tool_result blocks.
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: message.content,
              is_error: message.isError ?? false,
            },
          ],
        });
        continue;
      }

      const content: Record<string, unknown>[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseArgsLoose(call.arguments),
        });
      }
      messages.push({ role: "assistant", content });
    }

    const payload: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      messages,
    };
    if (systemParts.length > 0) payload.system = systemParts.join("\n\n");
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    if (typeof request.temperature === "number") payload.temperature = request.temperature;
    if (request.extra) Object.assign(payload, request.extra);
    return payload;
  }
}

interface AnthropicResponse {
  content?: {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  stop_reason?: string;
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: { type?: string; id?: string; name?: string };
  message?: AnthropicResponse;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  error?: { error?: { message?: string } };
}

function fromWire(raw: AnthropicResponse): ChatResponse {
  let text = "";
  const toolCalls: ToolCall[] = [];

  (raw.content ?? []).forEach((block, index) => {
    if (block.type === "text" && block.text) text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? normaliseToolCallId("", index),
        name: block.name ?? "",
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  });

  const message: Message & { role: "assistant" } = {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };

  return {
    message,
    usage: mergeUsage(emptyUsage(), raw.usage ?? {}),
    finishReason: mapStopReason(raw.stop_reason),
  };
}

function mapStopReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case undefined:
      return "stop";
    default:
      return "stop";
  }
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function mergeUsage(
  base: Usage,
  delta: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  },
): Usage {
  const inputTokens = Math.max(base.inputTokens, delta.input_tokens ?? 0);
  const outputTokens = Math.max(base.outputTokens, delta.output_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(delta.cache_read_input_tokens ? { cacheReadTokens: delta.cache_read_input_tokens } : {}),
  };
}

function parseArgsLoose(raw: string): unknown {
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
