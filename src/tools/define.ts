import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolSpec } from "../types.ts";

/**
 * A tool the model can call.
 *
 * The Zod schema is the single source of truth: it validates the model's
 * arguments before the handler ever sees them, and it is what gets converted
 * to the JSON Schema advertised to the model. The two can never drift, which
 * is the failure mode that makes agents hallucinate argument names.
 */
export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  /** Concise one-line result shown in the transcript. */
  execute(input: z.infer<S>, context: ToolContext): Promise<ToolResult>;
  /** Concurrent-safe by default; set false for stateful or unsafe tools. */
  readonly concurrent: boolean;
  /** Requires user approval before running. */
  readonly destructive: boolean;
}

export interface ToolContext {
  workspace: string;
  signal?: AbortSignal;
  /** Emits a progress line to the UI without ending the turn. */
  onProgress?(message: string): void;
  /**
   * Conversation state, when the caller binds it. `context_status` reads this
   * to report the live budget; tools that do not need it ignore it.
   */
  state?: unknown;
}

export interface ToolResult {
  /** Fed back to the model as tool output. Keep it small. */
  content: string;
  /** Shown to the user in the transcript. */
  display?: string;
  isError?: boolean;
}

export function defineTool<S extends z.ZodTypeAny>(tool: {
  name: string;
  description: string;
  schema: S;
  execute(input: z.infer<S>, context: ToolContext): Promise<ToolResult> | ToolResult;
  concurrent?: boolean;
  destructive?: boolean;
}): Tool<S> {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    execute: async (input, context) => tool.execute(input, context),
    concurrent: tool.concurrent ?? true,
    destructive: tool.destructive ?? false,
  };
}

export function toToolSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema, { target: "jsonSchema7" }) as Record<string, unknown>,
  };
}

export function success(content: string, display?: string): ToolResult {
  return display ? { content, display } : { content };
}

export function failure(error: string): ToolResult {
  return { content: `Error: ${error}`, isError: true };
}

/**
 * Validate raw model arguments against a tool's schema.
 *
 * Models produce valid JSON often but not always, and a schema error is far
 * more recoverable than an exception thrown deep in a handler.
 */
export function validateArgs<S extends z.ZodTypeAny>(
  tool: Tool<S>,
  raw: string,
): { ok: true; input: z.infer<S> } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      message: `arguments for ${tool.name} were not valid JSON: ${(error as Error).message}`,
    };
  }

  const result = tool.schema.safeParse(parsed);
  if (result.success) return { ok: true, input: result.data as z.infer<S> };

  const issues = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, message: `invalid arguments for ${tool.name}: ${issues}` };
}
