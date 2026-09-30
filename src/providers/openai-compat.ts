import type {
  ChatRequest,
  ChatResponse,
  Message,
  Provider,
  StreamEvent,
  ToolCall,
  Usage,
} from "../types.ts";
import { assertNonEmpty, jsonRequest, sseStream } from "./http.ts";

/**
 * OpenAI Chat Completions and every provider that mirrors it
 * (OpenRouter, Groq, Mistral, DeepSeek, xAI, LM Studio, llama.cpp server).
 *
 * One adapter covers seven vendors because the wire format genuinely is the
 * same; only baseUrl, key env var, and model naming differ. Anything that
 * deviates (Gemini, Anthropic) gets its own adapter.
 */
export class OpenAICompatProvider implements Provider {
  readonly supportsStreaming = true;
  readonly name: string;

  constructor(
    private readonly opts: {
      name: string;
      baseUrl: string;
      apiKey?: string;
      model: string;
      /** LM Studio and llama.cpp reject an Authorization header without a key. */
      sendAuthHeader: boolean;
    },
  ) {
    this.name = opts.name;
    this.model = opts.model;
  }

  readonly model: string;

  async listModels(): Promise<string[]> {
    const data = await jsonRequest<{ data?: { id?: string }[] }>({
      url: `${trimSlash(this.opts.baseUrl)}/models`,
      method: "GET",
      headers: this.headers(),
    });
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string")
      .sort();
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    assertNonEmpty(request);
    const response = await fetch(`${trimSlash(this.opts.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: { ...this.headers(), accept: "application/json" },
      body: JSON.stringify(this.toWire(request, false)),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${this.name} ${response.status}: ${text.slice(0, 2000)}`);

    const raw = JSON.parse(text) as OpenAIResponse;
    return normaliseOpenAI(raw);
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    assertNonEmpty(request);
    const byIndex = new Map<number, ToolCall>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    try {
      for await (const frame of sseStream({
        url: `${trimSlash(this.opts.baseUrl)}/chat/completions`,
        headers: this.headers(),
        body: this.toWire(request, true),
      })) {
        const chunk = safeParse(frame.data) as OpenAIChunk | null;
        if (!chunk) continue;

        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: "text", text: delta.content };
        }
        // DeepSeek-R1 and friends stream reasoning separately.
        if (delta.reasoning_content) {
          yield { type: "reasoning", text: delta.reasoning_content };
        }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          const existing = byIndex.get(index);
          if (existing) {
            existing.arguments += call.function?.arguments ?? "";
            if (call.function?.name) existing.name = call.function.name;
          } else {
            byIndex.set(index, {
              id: call.id ?? `call_${index}`,
              name: call.function?.name ?? "",
              arguments: call.function?.arguments ?? "",
            });
          }
        }
      }

      yield { type: "usage", usage };
      const calls = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
      yield { type: "done", reason: calls.length > 0 ? "toolUse" : "stop" };
      for (const call of calls) yield { type: "toolCall", call };
    } catch (error) {
      yield { type: "error", error: error instanceof Error ? error.message : String(error) };
      yield { type: "done", reason: "error" };
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.opts.apiKey && this.opts.sendAuthHeader) {
      headers.authorization = `Bearer ${this.opts.apiKey}`;
    }
    return headers;
  }

  private toWire(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    if (request.system) messages.push({ role: "system", content: request.system });

    for (const message of request.messages) {
      if (message.role === "system") {
        messages.push({ role: "system", content: message.content });
      } else if (message.role === "tool") {
        messages.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        });
      } else if (message.role === "assistant" && message.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        });
      } else {
        messages.push({ role: message.role, content: message.content });
      }
    }

    const payload: Record<string, unknown> = {
      model: request.model,
      messages,
      stream,
    };
    if (request.maxTokens) payload.max_tokens = request.maxTokens;
    if (typeof request.temperature === "number") payload.temperature = request.temperature;
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    if (stream) payload.stream_options = { include_usage: true };
    if (request.extra) Object.assign(payload, request.extra);
    return payload;
  }
}

interface OpenAIResponse {
  choices?: {
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenAIChunk {
  choices?: {
    index?: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

export function normaliseOpenAI(raw: OpenAIResponse): ChatResponse {
  const choice = raw.choices?.[0];
  const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? "",
    arguments: call.function?.arguments ?? "{}",
  }));

  const message: Message & { role: "assistant" } = {
    role: "assistant",
    content: choice?.message?.content ?? "",
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };

  const inputTokens = raw.usage?.prompt_tokens ?? 0;
  const outputTokens = raw.usage?.completion_tokens ?? 0;
  return {
    message,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: raw.usage?.total_tokens ?? inputTokens + outputTokens,
    },
    finishReason: mapFinish(choice?.finish_reason, toolCalls.length),
  };
}

function mapFinish(
  reason: string | undefined,
  toolCallCount: number,
): ChatResponse["finishReason"] {
  if (toolCallCount > 0) return "toolUse";
  if (reason === "length" || reason === "max_tokens") return "length";
  if (reason === "tool_calls" || reason === "function_call") return "toolUse";
  return "stop";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
