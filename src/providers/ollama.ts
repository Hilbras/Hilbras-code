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
import { assertNonEmpty, jsonRequest, ndjsonStream } from "./http.ts";

/**
 * Ollama, plus anything that speaks the same local OpenAI-ish shape
 * (LM Studio, llama.cpp's server, vLLM behind a shim).
 *
 * Local models are usually the reason someone reaches for a CLI agent
 * offline, so the default here is a longer step budget and no key.
 */
export class OllamaProvider implements Provider {
  readonly name = "ollama";
  readonly supportsStreaming = true;

  constructor(
    readonly model: string,
    private readonly host: string = "http://127.0.0.1:11434",
  ) {
    this.host = host.replace(/\/+$/, "");
  }

  async listModels(): Promise<string[]> {
    const data = await jsonRequest<{ models?: { name?: string }[] }>({
      url: `${this.host}/api/tags`,
      method: "GET",
    });
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === "string");
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    assertNonEmpty(request);
    const response = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ ...this.toWire(request), stream: false }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${text.slice(0, 2000)}`);

    const raw = JSON.parse(text) as {
      message?: {
        content?: string;
        tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
      };
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: string;
    };

    const toolCalls: ToolCall[] = (raw.message?.tool_calls ?? []).map((call, index) => ({
      id: `ollama_${index}`,
      name: call.function?.name ?? "",
      arguments:
        typeof call.function?.arguments === "string"
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments ?? {}),
    }));

    const inputTokens = raw.prompt_eval_count ?? 0;
    const outputTokens = raw.eval_count ?? 0;
    return {
      message: {
        role: "assistant",
        content: raw.message?.content ?? "",
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      finishReason: toolCalls.length > 0 ? "toolUse" : mapDone(raw.done_reason),
    };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    assertNonEmpty(request);
    const calls: ToolCall[] = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    try {
      for await (const line of ndjsonStream({
        url: `${this.host}/api/chat`,
        body: { ...this.toWire(request), stream: true },
      })) {
        const chunk = safeParse(line.data) as {
          message?: {
            content?: string;
            tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
          };
          prompt_eval_count?: number;
          eval_count?: number;
          done?: boolean;
        } | null;
        if (!chunk) continue;

        const delta = chunk.message?.content ?? "";
        if (delta) {
          yield { type: "text", text: delta };
        }
        for (const call of chunk.message?.tool_calls ?? []) {
          calls.push({
            id: `ollama_${calls.length}`,
            name: call.function?.name ?? "",
            arguments:
              typeof call.function?.arguments === "string"
                ? call.function.arguments
                : JSON.stringify(call.function?.arguments ?? {}),
          });
        }
        if (chunk.prompt_eval_count || chunk.eval_count) {
          const inputTokens = chunk.prompt_eval_count ?? usage.inputTokens;
          const outputTokens = chunk.eval_count ?? usage.outputTokens;
          usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
        }
        if (chunk.done) break;
      }

      yield { type: "usage", usage };
      yield { type: "done", reason: calls.length > 0 ? "toolUse" : "stop" };
      for (const call of calls) yield { type: "toolCall", call };
    } catch (error) {
      yield { type: "error", error: error instanceof Error ? error.message : String(error) };
      yield { type: "done", reason: "error" };
    }
  }

  private toWire(request: ChatRequest): Record<string, unknown> {
    // Ollama's /api/chat has no system role; fold it into a leading user turn.
    const messages = request.messages.map((m: Message) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user",
      content: m.role === "tool" ? `${m.name}: ${m.content}` : m.content,
    }));

    const payload: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
      options: {
        num_ctx: (request.extra?.num_ctx as number | undefined) ?? 32768,
        temperature: request.temperature ?? 0,
      },
    };
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
    return payload;
  }
}

function mapDone(reason: string | undefined): FinishReason {
  if (reason === "length") return "length";
  return "stop";
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
