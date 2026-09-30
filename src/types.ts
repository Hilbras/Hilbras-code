/**
 * Core type contracts shared by the provider, tool, and session layers.
 *
 * These shapes are intentionally provider-agnostic. Every model API in
 * `src/providers/` is normalised into these before the agent loop sees it, so
 * adding a new provider never requires touching `src/agent/`.
 */

/** A single message in the conversation, in normalised form. */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

/** A request for the model to invoke a tool. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string exactly as the provider emitted it. */
  arguments: string;
}

/** Token accounting for one request/response pair. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
}

/** Streaming delta kinds. Providers must emit exactly these. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolCall"; call: ToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "error"; error: string }
  | { type: "done"; reason: FinishReason };

export type FinishReason = "stop" | "toolUse" | "length" | "error" | "aborted";

/** A tool as advertised to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft-07 compatible subset) for the arguments object. */
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  system?: string;
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  /** Provider-specific passthrough (thinking budget, reasoning effort, ...). */
  extra?: Record<string, unknown>;
}

export interface ChatResponse {
  message: Message & { role: "assistant" };
  usage: Usage;
  finishReason: FinishReason;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  /** True when the provider can emit incremental text. */
  readonly supportsStreaming: boolean;
  /** Models this provider has been tested against, best first. */
  listModels(): Promise<string[]>;
  complete(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncGenerator<StreamEvent>;
}

/** Runtime configuration, resolved from env + config file + CLI flags. */
export interface Config {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens: number;
  temperature: number;
  /** Enables the local-runtime path (Ollama, llama.cpp, LM Studio, ...). */
  local: boolean;
  workspace: string;
  /** Follow the agent's file edits automatically. */
  followMode: boolean;
  maxSteps: number;
}
