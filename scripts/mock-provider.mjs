#!/usr/bin/env node
/**
 * A scripted provider that performs the smoke-live task deterministically.
 *
 * This does not test model quality. It tests that `scripts/smoke-live.sh` is
 * wired correctly end to end: that the CLI accepts the flags, that the agent
 * loop runs, that tools execute against a real workspace, and that the script's
 * own assertions pass on a good run. Without this, a failure in the smoke script
 * is indistinguishable from a failure of the agent.
 *
 * Run:  node scripts/mock-provider.mjs <port>
 */
import { createServer } from "node:http";

const port = Number.parseInt(process.argv[2] ?? "8788", 10);

/** One response per turn. Tool args must be valid JSON inside a JSON string. */
const SCRIPT = [
  {
    text: "Reading the task and the target file.",
    toolCalls: [
      { name: "read_file", arguments: { path: "greeting.js" } },
      { name: "read_file", arguments: { path: "TASK.md" } },
    ],
  },
  {
    text: "Updating the function and writing the test.",
    toolCalls: [
      {
        name: "edit_file",
        arguments: {
          path: "greeting.js",
          old_string: 'return "hello";',
          new_string: 'return "hello, world";',
          replace_all: false,
        },
      },
      {
        name: "write_file",
        arguments: {
          path: "greeting.test.js",
          content:
            'import test from "node:test";\n' +
            'import assert from "node:assert/strict";\n' +
            'import { greet } from "./greeting.js";\n\n' +
            'test("greet returns hello, world", () => {\n' +
            '  assert.equal(greet(), "hello, world");\n' +
            '});\n',
        },
      },
    ],
  },
  {
    text: "Running the test.",
    toolCalls: [
      {
        name: "run_shell",
        arguments: { command: "node --test greeting.test.js 2>&1 | tail -5" },
      },
    ],
  },
  {
    text: "Done. greet() now returns \"hello, world\", I wrote greeting.test.js, and node --test passes.",
  },
];

let turn = 0;

const server = createServer((req, res) => {
  if (!req.url?.includes("/messages")) {
    res.writeHead(404).end("{}");
    return;
  }

  // The CLI always sets stream:true, so this must answer with SSE. A
  // non-streaming JSON body here would silently yield zero turns.
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let wantsStream = false;
    try {
      wantsStream = JSON.parse(raw).stream === true;
    } catch {
      // An unparseable body still gets the streaming response below.
    }

    const step = SCRIPT[Math.min(turn, SCRIPT.length - 1)];
    turn += 1;
    if (process.env.MOCK_DEBUG) {
      console.error(`[mock] turn=${turn} stream=${wantsStream}`);
      console.error(`[mock] body: ${raw.slice(0, 400)}`);
    }

    if (!wantsStream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(nonStreamingBody(step, turn)));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const frame of streamingFrames(step, turn)) res.write(frame);
    res.end();
  });
});

/** Builds the SSE frame sequence for one turn. */
function streamingFrames(step, id) {
  const frames = [];
  const push = (type, payload) => {
    frames.push(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  push("message_start", {
    type: "message_start",
    message: { usage: { input_tokens: 100, output_tokens: 0 } },
  });

  const blocks = [];
  if (step.text) blocks.push({ type: "text", text: step.text });
  for (const call of step.toolCalls ?? []) {
    blocks.push({ type: "tool_use", id: `mock_${id}_${blocks.length}`, name: call.name });
  }

  // The tool index within `step.toolCalls` is NOT the content block index: a
  // leading text block shifts everything by one. Track them separately.
  let toolIndex = 0;
  blocks.forEach((block, index) => {
    push("content_block_start", { type: "content_block_start", index, content_block: block });
    if (block.type === "text") {
      push("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
      return;
    }
    const args = step.toolCalls[toolIndex].arguments;
    toolIndex += 1;
    push("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
    });
  });

  push("message_delta", {
    type: "message_delta",
    delta: { stop_reason: (step.toolCalls ?? []).length > 0 ? "tool_use" : "end_turn" },
    usage: { output_tokens: 20 },
  });
  push("message_stop", { type: "message_stop" });

  return frames;
}

function nonStreamingBody(step, id) {
  const content = [];
  if (step.text) content.push({ type: "text", text: step.text });
  for (const [i, call] of (step.toolCalls ?? []).entries()) {
    content.push({ type: "tool_use", id: `mock_${id}_${i}`, name: call.name, input: call.arguments });
  }
  return {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    model: "mock",
    content,
    stop_reason: (step.toolCalls ?? []).length > 0 ? "tool_use" : "end_turn",
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

server.listen(port, "127.0.0.1", () => {
  console.log(`mock anthropic endpoint on http://127.0.0.1:${port}`);
});
