import { z } from "zod";
import type { Message, Usage } from "../types.ts";
import { type ToolContext, defineTool, success } from "./define.ts";

/**
 * Agent-internal tools: the ability to look at its own context budget.
 *
 * A model that can see how much room it has left stops dumping 2000-line files
 * without thinking; a model that cannot does it every turn. This is the
 * cheapest quality win in the tool set, so it is bound to real conversation
 * state rather than shipped as a stub.
 */

export interface ContextState {
  /** Live conversation, referenced rather than copied. */
  messages: Message[];
  /** Model's context window in tokens. */
  contextWindow: number;
  /** Rough chars-per-token ratio for the estimate below. */
  charsPerToken?: number;
}

const CHARS_PER_TOKEN = 3.6;

export const contextTool = defineTool({
  name: "context_status",
  description:
    "Report current context usage: tokens used, tokens remaining before the model's " +
    "limit, and which messages are consuming them. Call this before reading several " +
    "large files, and when you need to decide what to summarise.",
  schema: z.object({
    detail: z
      .enum(["summary", "messages"])
      .optional()
      .default("summary")
      .describe("'summary' for totals, 'messages' for a per-message breakdown"),
  }),
  execute: async (input, context) => {
    const state = (context as ToolContext & { state?: ContextState }).state;
    if (!state) {
      return success("Context tracking is not bound to this session.", "context: not bound");
    }

    const rows = state.messages.map((message, index) => ({
      index,
      role: message.role,
      toolCalls: "toolCalls" in message ? (message.toolCalls?.length ?? 0) : 0,
      text: messageText(message),
    }));
    const perMessage = rows.map((row) => ({ ...row, tokens: estimateTokens(row.text) }));
    const used = perMessage.reduce((sum, row) => sum + row.tokens, 0);
    const remaining = Math.max(0, state.contextWindow - used);
    const percent = ((used / state.contextWindow) * 100).toFixed(1);

    if (input.detail === "messages") {
      const lines = perMessage
        .map(
          (row) =>
            `  [${String(row.index).padStart(3, " ")}] ${row.role.padEnd(9, " ")} ` +
            `${String(row.tokens).padStart(6, " ")} tok${row.toolCalls ? ` +${row.toolCalls} tool call(s)` : ""}`,
        )
        .join("\n");
      return success(
        `${lines}\n\nTotal: ${used} / ${state.contextWindow} tokens (${percent}%). ` +
          `Remaining: ${remaining}.`,
        `context: ${used}/${state.contextWindow} (${percent}%)`,
      );
    }

    const biggest = [...perMessage].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
    const breakdown = biggest
      .map((row) => `[${row.index}] ${row.role} = ${row.tokens} tok`)
      .join(", ");

    const verdict =
      remaining < state.contextWindow * 0.2
        ? "Budget is tight — summarise or stop reading before continuing."
        : "Plenty of room.";

    return success(
      `Using ${used} of ${state.contextWindow} tokens (${percent}%). Remaining: ${remaining}. ` +
        `Largest messages: ${breakdown}. ${verdict}`,
      `context: ${used}/${state.contextWindow} tokens (${percent}%)`,
    );
  },
});

export const agentTools = [contextTool];

function messageText(message: Message): string {
  if (message.role === "tool") return message.content;
  const base = message.content;
  const calls = "toolCalls" in message ? (message.toolCalls ?? []) : [];
  const callText = calls.map((call) => `${call.name}${call.arguments}`).join(" ");
  return `${base} ${callText}`;
}

export function estimateTokens(text: string): number {
  if (text === "") return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function createContextState(contextWindow: number, messages: Message[] = []): ContextState {
  return { messages, contextWindow };
}

export type { Usage };
