import { afterAll, describe, expect, test } from "bun:test";
import { runAgent } from "../src/agent/loop.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { OpenAICompatProvider } from "../src/providers/openai-compat.ts";
import { editFileTool, readFileTool, writeFileTool } from "../src/tools/files.ts";
import type { Config } from "../src/types.ts";

/**
 * End-to-end coverage against a local server speaking the real wire protocol.
 *
 * These tests drive the actual HTTP/streaming code — SSE framing, tool-call
 * accumulation across deltas, usage merging — rather than mocking the provider,
 * so a regression in the parsing layer fails here and not in production.
 */

const servers: { stop(): void }[] = [];

afterAll(() => {
  for (const server of servers) server.stop();
});

function startServer(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({
    port: 0,
    fetch: handler,
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const sse = (frames: string[]): Response =>
  new Response(frames.join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("AnthropicProvider streaming", () => {
  test("parses text deltas, tool calls, and usage from a real SSE stream", async () => {
    const base = startServer(() => {
      return sse([
        frame("message_start", {
          type: "message_start",
          message: { usage: { input_tokens: 1500, output_tokens: 0 } },
        }),
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "write_file" },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":"note' },
        }),
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '.txt","content":"hi"}' },
        }),
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 42 },
        }),
        frame("message_stop", { type: "message_stop" }),
      ]);
    });

    const provider = new AnthropicProvider("test-key", "claude-test", `${base}/v1/messages`);
    const events = [];
    for await (const event of provider.stream({
      model: "claude-test",
      messages: [{ role: "user", content: "write a file" }],
      maxTokens: 1024,
    })) {
      events.push(event);
    }

    // The tool name arrives in content_block_start; its JSON arguments are
    // split across two deltas and must be concatenated into valid JSON.
    const call = events.find((e) => e.type === "toolCall");
    expect(call).toBeDefined();
    if (call?.type === "toolCall") {
      expect(call.call.name).toBe("write_file");
      expect(JSON.parse(call.call.arguments)).toEqual({ path: "note.txt", content: "hi" });
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ reason: "toolUse" });

    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ type: "usage" });
    if (usage?.type === "usage") {
      expect(usage.usage.inputTokens).toBe(1500);
      expect(usage.usage.outputTokens).toBe(42);
      expect(usage.usage.totalTokens).toBe(1542);
    }
  });

  test("surfaces an HTTP error instead of hanging", async () => {
    const base = startServer(
      () => new Response("rate limit exceeded", { status: 429, statusText: "Too Many Requests" }),
    );
    const provider = new AnthropicProvider("bad-key", "claude-test", `${base}/v1/messages`);

    const events = [];
    for await (const event of provider.stream({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(event);
    }
    expect(events[0]?.type).toBe("error");
    expect(JSON.stringify(events)).toContain("429");
  });

  test("handles a multi-frame frame split across TCP chunks", async () => {
    // Each SSE frame is written as its own tiny chunk to force buffering logic.
    const frames = [
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello " },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world" },
      }),
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ];
    const body = frames.join("");
    const base = startServer(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              const bytes = new TextEncoder().encode(body);
              for (let i = 0; i < bytes.length; i += 7) {
                controller.enqueue(bytes.slice(i, i + 7));
                await new Promise((resolve) => setTimeout(resolve, 1));
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const provider = new AnthropicProvider("test-key", "claude-test", `${base}/v1/messages`);
    let text = "";
    for await (const event of provider.stream({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (event.type === "text") text += event.text;
    }
    expect(text).toBe("hello world");
  });
});

describe("OpenAI-compatible streaming", () => {
  test("accumulates tool-call arguments by index and streams reasoning", async () => {
    let requestBody: Record<string, unknown> = {};
    const base = startServer(async (request) => {
      requestBody = (await request.json()) as Record<string, unknown>;
      const frames = [
        frame("", { choices: [{ delta: { reasoning_content: "thinking..." } }] }),
        frame("", {
          choices: [
            { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "edit_file" } }] } },
          ],
        }),
        frame("", {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a' } }] } },
          ],
        }),
        frame("", {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] } }],
        }),
        frame("", {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 500, completion_tokens: 30, total_tokens: 530 },
        }),
      ];
      return sse(frames);
    });

    const provider = new OpenAICompatProvider({
      name: "groq",
      baseUrl: `${base}/v1`,
      apiKey: "k",
      model: "m",
      sendAuthHeader: true,
    });

    const events = [];
    for await (const event of provider.stream({
      model: "m",
      messages: [{ role: "user", content: "edit" }],
      tools: [{ name: "edit_file", description: "d", inputSchema: {} }],
    })) {
      events.push(event);
    }

    const call = events.find((e) => e.type === "toolCall");
    expect(call).toBeDefined();
    if (call?.type === "toolCall") {
      expect(call.call.name).toBe("edit_file");
      expect(JSON.parse(call.call.arguments)).toEqual({ path: "a.ts" });
    }
    expect(events.some((e) => e.type === "reasoning")).toBe(true);
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      usage: { totalTokens: 530 },
    });
    // The system prompt must travel as a real system message for this family.
    expect(requestBody.stream_options).toEqual({ include_usage: true });
  });
});

describe("agent loop over a real provider transport", () => {
  test("writes a file when the model asks for it", async () => {
    const dir = `${import.meta.dir}/../.tmp-e2e-${Date.now()}`;
    await Bun.write(`${dir}/.keep`, "");

    let turn = 0;
    const base = startServer(() => {
      turn += 1;
      if (turn === 1) {
        return sse([
          frame("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "t1", name: "write_file" },
          }),
          frame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({
                path: "greeting.txt",
                content: "hello from the agent",
              }),
            },
          }),
          frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
        ]);
      }
      return sse([
        frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Created greeting.txt." },
        }),
        frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
      ]);
    });

    const provider = new AnthropicProvider("test-key", "claude-test", `${base}/v1/messages`);
    const config: Config = {
      provider: "anthropic",
      model: "claude-test",
      maxTokens: 2048,
      temperature: 0,
      local: false,
      workspace: dir,
      followMode: true,
      maxSteps: 5,
    };

    const result = await runAgent([{ role: "user", content: "create greeting.txt" }], {
      config,
      provider,
      tools: [writeFileTool, editFileTool, readFileTool],
      system: "You are a test agent.",
    });

    expect(result.stopReason).toBe("completed");
    expect(result.steps).toBe(2);
    expect(await Bun.file(`${dir}/greeting.txt`).text()).toBe("hello from the agent");
    expect(result.messages.at(-1)).toMatchObject({ content: "Created greeting.txt." });
  });
});
