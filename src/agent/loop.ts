import type { Tool, ToolResult } from "../tools/define.ts";
import { toToolSpec, validateArgs } from "../tools/define.ts";
import type { Config, Message, Provider, StreamEvent, Usage } from "../types.ts";

/**
 * The agent loop.
 *
 * One turn is: stream the model's reply, run whatever tools it asked for, feed
 * the results back, repeat. Everything interesting about a coding agent lives
 * in the seams around that loop — tool result size, step budget, what happens
 * when the model keeps calling tools forever — so those are explicit
 * parameters here rather than scattered constants.
 */

export interface AgentEvents {
  onText?(text: string): void;
  onReasoning?(text: string): void;
  onToolStart?(name: string, args: string): void;
  onToolEnd?(name: string, result: ToolResult): void;
  onUsage?(usage: Usage): void;
  onStep?(step: number, maxSteps: number): void;
}

export interface AgentOptions {
  config: Config;
  provider: Provider;
  tools: Tool[];
  system?: string;
  events?: AgentEvents;
  signal?: AbortSignal;
  /** Conversation state handed to every tool as `context.state`. */
  state?: unknown;
}

export interface TurnResult {
  messages: Message[];
  steps: number;
  usage: Usage;
  stopReason: "completed" | "maxSteps" | "error" | "aborted";
}

export async function runAgent(
  initialMessages: Message[],
  options: AgentOptions,
): Promise<TurnResult> {
  const { config, provider, tools, events = {} } = options;
  const messages: Message[] = [...initialMessages];
  const specs = tools.map(toToolSpec);
  const totals: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let steps = 0;

  while (steps < config.maxSteps) {
    if (options.signal?.aborted) {
      return { messages, steps, usage: totals, stopReason: "aborted" };
    }
    steps += 1;
    events.onStep?.(steps, config.maxSteps);

    const request = {
      model: config.model,
      messages,
      ...(options.system ? { system: options.system } : {}),
      tools: specs,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    };

    const collected = await collectStream(provider, request, events, options.signal);
    if (collected.error) {
      return { messages, steps, usage: totals, stopReason: "error" };
    }

    totals.inputTokens += collected.usage.inputTokens;
    totals.outputTokens += collected.usage.outputTokens;
    totals.totalTokens += collected.usage.totalTokens;
    events.onUsage?.(totals);

    messages.push(collected.assistant);

    // No tool calls means the model believes it is finished.
    if (collected.toolCalls.length === 0) {
      return { messages, steps, usage: totals, stopReason: "completed" };
    }

    const results = await executeToolCalls(
      collected.toolCalls,
      tools,
      config,
      events,
      options.signal,
      options.state,
    );
    for (const result of results) messages.push(result);
  }

  return { messages, steps, usage: totals, stopReason: "maxSteps" };
}

interface Collected {
  assistant: Message & { role: "assistant" };
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: Usage;
  error: boolean;
}

async function collectStream(
  provider: Provider,
  request: Parameters<Provider["stream"]>[0],
  events: AgentEvents,
  signal?: AbortSignal,
): Promise<Collected> {
  let text = "";
  const toolCalls: Collected["toolCalls"] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let error = false;

  const consume = async (iterator: AsyncGenerator<StreamEvent>) => {
    for await (const event of iterator) {
      switch (event.type) {
        case "text":
          text += event.text;
          events.onText?.(event.text);
          break;
        case "reasoning":
          events.onReasoning?.(event.text);
          break;
        case "toolCall":
          toolCalls.push(event.call);
          break;
        case "usage":
          usage = event.usage;
          break;
        case "error":
          error = true;
          events.onText?.(`\n[error] ${event.error}\n`);
          break;
        case "done":
          break;
      }
    }
  };

  if (provider.supportsStreaming) {
    await consume(provider.stream(request));
  } else {
    const response = await provider.complete(request);
    const message = response.message;
    text = message.content;
    toolCalls.push(...(message.toolCalls ?? []));
    usage = response.usage;
    if (text) events.onText?.(text);
  }

  void signal;
  const assistant: Message & { role: "assistant" } = {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  return { assistant, toolCalls, usage, error };
}

async function executeToolCalls(
  calls: Collected["toolCalls"],
  tools: Tool[],
  config: Config,
  events: AgentEvents,
  signal?: AbortSignal,
  state?: unknown,
): Promise<Message[]> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // Tools marked non-concurrent run one at a time, in call order; the rest run
  // together. File edits must serialise, reads need not. An unknown tool is
  // batched alone so runTool reports it rather than it running concurrently.
  const batches: { tool: Tool | undefined; call: Collected["toolCalls"][number] }[][] = [];
  let current: (typeof batches)[number] = [];
  for (const call of calls) {
    const tool = byName.get(call.name);
    if (!tool || !tool.concurrent) {
      if (current.length > 0) batches.push(current);
      current = [];
      batches.push([{ tool, call }]);
    } else {
      current.push({ tool, call });
    }
  }
  if (current.length > 0) batches.push(current);

  const messages: Message[] = [];
  for (const batch of batches) {
    const settled = await Promise.all(
      batch.map(async ({ tool, call }) => {
        events.onToolStart?.(call.name, call.arguments);
        const result = await runTool(tool, call, config, signal, state);
        events.onToolEnd?.(call.name, result);
        return result;
      }),
    );
    for (const result of settled) {
      messages.push({
        role: "tool",
        toolCallId: result.toolCallId,
        name: result.name,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      });
    }
  }
  return messages;
}

async function runTool(
  tool: Tool | undefined,
  call: Collected["toolCalls"][number],
  config: Config,
  signal?: AbortSignal,
  state?: unknown,
): Promise<{ toolCallId: string; name: string; content: string; isError?: boolean }> {
  if (!tool) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `Error: no such tool "${call.name}". Available tools: run_shell, read_file, write_file, edit_file, search_files, grep, list_dir, git.`,
      isError: true,
    };
  }

  const validated = validateArgs(tool, call.arguments);
  if (!validated.ok) {
    return { toolCallId: call.id, name: call.name, content: validated.message, isError: true };
  }

  try {
    const result = await tool.execute(validated.input, {
      workspace: config.workspace,
      ...(signal ? { signal } : {}),
      ...(state !== undefined ? { state } : {}),
    });
    return {
      toolCallId: call.id,
      name: call.name,
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
    };
  } catch (error) {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}
