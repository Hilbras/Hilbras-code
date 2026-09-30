import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAgent } from "../src/agent/loop.ts";
import { defineTool, toToolSpec, validateArgs } from "../src/tools/define.ts";
import type { ChatRequest, ChatResponse, Provider, StreamEvent, Usage } from "../src/types.ts";
import type { Config } from "../src/types.ts";

/** A provider that replays a scripted sequence of replies. */
class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly model = "test";
  readonly supportsStreaming = true;
  requests: ChatRequest[] = [];

  constructor(
    private readonly script: { text?: string; toolCalls?: { name: string; args: string }[] }[],
  ) {}

  listModels(): Promise<string[]> {
    return Promise.resolve(["test"]);
  }

  complete(): Promise<ChatResponse> {
    throw new Error("not used in these tests");
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(request);
    const turn = this.script[this.requests.length - 1];
    if (!turn) throw new Error(`script exhausted after ${this.requests.length} turns`);
    if (turn.text) yield { type: "text", text: turn.text };
    const usage: Usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
    yield { type: "usage", usage };
    for (const call of turn.toolCalls ?? []) {
      yield {
        type: "toolCall",
        call: { id: `c${this.requests.length}`, name: call.name, arguments: call.args },
      };
    }
    yield { type: "done", reason: (turn.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop" };
  }
}

const baseConfig: Config = {
  provider: "scripted",
  model: "test",
  maxTokens: 1024,
  temperature: 0,
  local: false,
  workspace: process.cwd(),
  followMode: true,
  maxSteps: 5,
};

const echoTool = defineTool({
  name: "echo",
  description: "Echo the input back.",
  schema: z.object({ text: z.string() }),
  execute: (input) => ({ content: `echo:${input.text}` }),
});

const failTool = defineTool({
  name: "fail",
  description: "Always fails.",
  schema: z.object({}),
  execute: () => ({ content: "boom", isError: true }),
});

describe("runAgent", () => {
  test("stops when the model returns no tool calls", async () => {
    const provider = new ScriptedProvider([{ text: "all done" }]);
    const result = await runAgent([{ role: "user", content: "hi" }], {
      config: baseConfig,
      provider,
      tools: [echoTool],
    });

    expect(result.stopReason).toBe("completed");
    expect(result.steps).toBe(1);
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "all done" });
  });

  test("feeds tool results back for another step", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "echo", args: '{"text":"hi"}' }] },
      { text: "finished" },
    ]);

    const result = await runAgent([{ role: "user", content: "say hi" }], {
      config: baseConfig,
      provider,
      tools: [echoTool],
    });

    expect(result.stopReason).toBe("completed");
    expect(result.steps).toBe(2);
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ name: "echo", content: "echo:hi" });
  });

  test("propagates tool errors to the model instead of aborting", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "fail", args: "{}" }] },
      { text: "recovered" },
    ]);

    const result = await runAgent([{ role: "user", content: "go" }], {
      config: baseConfig,
      provider,
      tools: [failTool],
    });

    expect(result.stopReason).toBe("completed");
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ isError: true, content: "boom" });
  });

  test("stops at maxSteps instead of looping forever", async () => {
    // Every turn asks for a tool, so the only exit is the step budget.
    const provider = new ScriptedProvider(
      Array.from({ length: 20 }, () => ({ toolCalls: [{ name: "echo", args: '{"text":"x"}' }] })),
    );

    const result = await runAgent([{ role: "user", content: "loop" }], {
      config: { ...baseConfig, maxSteps: 3 },
      provider,
      tools: [echoTool],
    });

    expect(result.stopReason).toBe("maxSteps");
    expect(result.steps).toBe(3);
  });

  test("an unknown tool name is reported, not thrown", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "ghost", args: "{}" }] },
      { text: "ok" },
    ]);

    const result = await runAgent([{ role: "user", content: "go" }], {
      config: baseConfig,
      provider,
      tools: [echoTool],
    });

    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ isError: true });
    expect((toolMessage as { content: string }).content).toContain("no such tool");
  });

  test("an abort signal halts the loop", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "echo", args: '{"text":"x"}' }] },
      { text: "should not get here" },
    ]);
    const controller = new AbortController();
    controller.abort();

    const result = await runAgent([{ role: "user", content: "go" }], {
      config: baseConfig,
      provider,
      tools: [echoTool],
      signal: controller.signal,
    });

    expect(result.stopReason).toBe("aborted");
  });

  test("accumulates usage across steps", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "echo", args: '{"text":"a"}' }] },
      { text: "done" },
    ]);

    const result = await runAgent([{ role: "user", content: "go" }], {
      config: baseConfig,
      provider,
      tools: [echoTool],
    });

    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(40);
    expect(result.usage.totalTokens).toBe(240);
  });
});

describe("tool argument validation", () => {
  test("accepts valid arguments", () => {
    const result = validateArgs(echoTool, '{"text":"hi"}');
    expect(result.ok).toBe(true);
  });

  test("rejects malformed JSON with a readable message", () => {
    const result = validateArgs(echoTool, "{text: hi}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("not valid JSON");
  });

  test("rejects arguments that miss a required field", () => {
    const result = validateArgs(echoTool, "{}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("text");
  });

  test("treats an empty string as no arguments", () => {
    const result = validateArgs(failTool, "");
    expect(result.ok).toBe(true);
  });
});

describe("toToolSpec", () => {
  test("produces a JSON Schema the provider can advertise", () => {
    const spec = toToolSpec(echoTool);
    expect(spec.name).toBe("echo");
    expect(spec.inputSchema).toHaveProperty("properties");
    const properties = spec.inputSchema.properties as Record<string, { type?: string }>;
    expect(properties.text?.type).toBe("string");
  });
});
