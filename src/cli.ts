#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { runAgent } from "./agent/loop.ts";
import { resolveConfig } from "./config/resolve.ts";
import { SUPPORTED_PROVIDERS, createProvider, localRuntimeHint } from "./providers/index.ts";
import { type ContextState, contextTool, createContextState } from "./tools/agent-tools.ts";
import type { Tool } from "./tools/define.ts";
import { fileTools } from "./tools/files.ts";
import { shellTools } from "./tools/shell.ts";
import { renderWelcome } from "./tui/welcome.ts";
import type { Message, Provider, Usage } from "./types.ts";

const VERSION = "0.1.0";

const SYSTEM_PROMPT = `You are Hilbras Code, a coding agent working in a user's repository.

How you work:
- Read before you edit. Never guess a file's contents — the file may have changed since you last saw it.
- Prefer edit_file over write_file when changing part of a file. It fails loudly on an ambiguous match; write_file silently discards everything you did not retype.
- Run the project's own tests or typechecker after making changes, and fix what fails, before you claim the work is done.
- Check context_status before reading several large files.

How you report:
- Say what you changed and what you verified. If you could not verify something, say so explicitly rather than implying you did.
- Keep prose short. The user is reading a terminal, not a document.`;

const TOOLS: Tool[] = [...fileTools, ...shellTools, contextTool];

const CONTEXT_WINDOWS: Record<string, number> = {
  anthropic: 200_000,
  openai: 128_000,
  openrouter: 128_000,
  groq: 128_000,
  mistral: 128_000,
  deepseek: 64_000,
  xai: 128_000,
  ollama: 32_768,
  lmstudio: 32_768,
  llamacpp: 32_768,
};

interface Flags {
  provider?: string;
  model?: string;
  baseUrl?: string;
  temperature?: string;
  maxSteps?: string;
  workspace?: string;
  system?: string;
  help: boolean;
  version: boolean;
  listProviders: boolean;
  listTools: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): { command?: string; flags: Flags; rest: string[] } {
  const flags: Flags = {
    help: false,
    version: false,
    listProviders: false,
    listTools: false,
    json: false,
  };
  const rest: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      i += 1;
      return value ?? "";
    };

    switch (arg) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "-v":
      case "--version":
        flags.version = true;
        break;
      case "-p":
      case "--provider":
        flags.provider = next();
        break;
      case "-m":
      case "--model":
        flags.model = next();
        break;
      case "--base-url":
        flags.baseUrl = next();
        break;
      case "-t":
      case "--temperature":
        flags.temperature = next();
        break;
      case "--max-steps":
        flags.maxSteps = next();
        break;
      case "-w":
      case "--workspace":
        flags.workspace = next();
        break;
      case "--system":
        flags.system = next();
        break;
      case "--list-providers":
        flags.listProviders = true;
        break;
      case "--list-tools":
        flags.listTools = true;
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        if (arg.startsWith("-")) break;
        if (command === undefined) command = arg;
        else rest.push(arg);
    }
  }
  return { command, flags, rest };
}

function usage(): string {
  return `hilbras-code ${VERSION} — a coding agent for your terminal

USAGE
  hilbras-code [options] [prompt]      run a single prompt and exit
  hilbras-code                         start an interactive session

OPTIONS
  -p, --provider <name>    ${SUPPORTED_PROVIDERS.join(" | ")}
  -m, --model <id>         model id to use
      --base-url <url>     override the provider base URL
  -t, --temperature <n>    sampling temperature (default 0)
      --max-steps <n>      max agent steps per turn (default 50)
  -w, --workspace <dir>    workspace root (default: cwd)
      --system <text>      replace the system prompt
      --json                emit NDJSON events instead of pretty output
      --list-providers      print supported providers
      --list-tools          print registered tools
  -h, --help               show this help
  -v, --version            show version

CONFIG
  Provider and model resolve from, in order of precedence:
    1. CLI flags
    2. HILBRAS_PROVIDER / HILBRAS_MODEL / HILBRAS_BASE_URL
    3. the provider's own key var (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
    4. hilbras-code.json in the workspace
    5. built-in defaults

  Local runtimes need no key: ollama (11434), lmstudio (1234), llamacpp (8080).

EXAMPLES
  hilbras-code -p anthropic "fix the failing test in src/parser.test.ts"
  hilbras-code -p ollama -m qwen2.5-coder "explain what this repo does"
  hilbras-code --list-tools`;
}

function main(): void {
  const { command, flags, rest } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (flags.help || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (flags.listProviders) {
    process.stdout.write(`${SUPPORTED_PROVIDERS.join("\n")}\n`);
    return;
  }
  if (flags.listTools) {
    for (const tool of TOOLS)
      process.stdout.write(`${tool.name}\t${tool.description.split("\n")[0]}\n`);
    return;
  }

  const promptFromArgs = [command, ...rest]
    .filter((part): part is string => Boolean(part))
    .join(" ");

  // MCP is not implemented yet. Say so plainly rather than advertising a
  // dependency the binary does not use.
  if (promptFromArgs.startsWith("mcp")) {
    process.stderr.write(
      "mcp: not implemented in 0.1.0.\n" +
        "MCP server support is planned; this build has no MCP client.\n",
    );
    process.exitCode = 1;
    return;
  }

  const base = resolveConfig(process.env, flags.workspace ?? process.cwd());
  const config = {
    ...base,
    ...(flags.provider ? { provider: flags.provider.toLowerCase() } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}),
    ...(flags.workspace ? { workspace: flags.workspace } : {}),
    ...(flags.temperature ? { temperature: Number.parseFloat(flags.temperature) } : {}),
    ...(flags.maxSteps ? { maxSteps: Number.parseInt(flags.maxSteps, 10) } : {}),
  };

  if (!existsSync(config.workspace)) {
    process.stderr.write(`workspace not found: ${config.workspace}\n`);
    process.exitCode = 1;
    return;
  }

  // A one-shot run has no chance to recover, so validate the provider now.
  // Interactive mode defers it: the welcome panel and the slash commands work
  // with no provider configured, and only a submitted task needs one. Failing
  // at startup would hide the UI and the guidance behind a one-line error.
  if (promptFromArgs) {
    let provider: Provider;
    try {
      provider = createProvider(config);
    } catch (error) {
      reportProviderFailure(config, error);
      return;
    }
    const contextState = createContextState(CONTEXT_WINDOWS[config.provider] ?? 128_000);
    const emit = flags.json ? ndjsonEmitter() : prettyEmitter();
    const system = flags.system ?? SYSTEM_PROMPT;
    void oneShot(promptFromArgs, config, provider, contextState, emit, system);
    return;
  }

  const contextState = createContextState(CONTEXT_WINDOWS[config.provider] ?? 128_000);
  const emit = flags.json ? ndjsonEmitter() : prettyEmitter();
  const system = flags.system ?? SYSTEM_PROMPT;
  void interactive(config, contextState, emit, system);
}

function reportProviderFailure(config: ReturnType<typeof resolveConfig>, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  const hint = localRuntimeHint(config.provider);
  if (hint) process.stderr.write(`${hint}\n`);
  process.exitCode = 1;
}

/** `/help` — must work with no provider configured, so it never touches one. */
function writeHelp(config: ReturnType<typeof resolveConfig>, emit: Emit): void {
  const lines: string[] = [
    "",
    "Commands",
    "  /help        show this help",
    "  /context     show the conversation breakdown",
    "  /clear       discard the conversation",
    "  /exit        leave",
    "",
    `Provider  ${config.provider} / ${config.model}`,
  ];

  if (!config.apiKey && !config.local) {
    lines.push(
      "",
      "  not configured — to send tasks, do one of:",
      "    export ANTHROPIC_API_KEY=...       (or OPENAI_API_KEY, OPENROUTER_API_KEY, ...)",
      "    hilbras-code -p ollama -m MODEL   local runtime, no key needed",
      "    hilbras-code -p lmstudio          or -p llamacpp",
      `  supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }

  lines.push("", "Tools the agent can use:", `  ${TOOLS.map((t) => t.name).join(", ")}`, "");
  // One write, not one per line: the text emitter streams a chunk verbatim, so
  // writing each line separately collapses them all onto one row.
  emit.text(`${lines.join("\n")}\n`);
}

type Emit = {
  text(chunk: string): void;
  reasoning(chunk: string): void;
  tool(name: string, phase: "start" | "end", detail?: string, isError?: boolean): void;
  step(step: number, max: number): void;
  usage(usage: Usage): void;
  error(message: string): void;
};

function prettyEmitter(): Emit {
  return {
    text: (chunk) => process.stdout.write(chunk),
    reasoning: (chunk) => process.stderr.write(dim(chunk)),
    tool: (name, phase, detail, isError) => {
      if (phase === "start") process.stderr.write(`\n${cyan("▸")} ${name}\n`);
      else process.stderr.write(`  ${isError ? red("✗") : green("✓")} ${detail ?? name}\n`);
    },
    step: (step, max) => process.stderr.write(dim(`  step ${step}/${max}\n`)),
    usage: (usage) =>
      process.stderr.write(dim(`  tokens: ${usage.inputTokens} in / ${usage.outputTokens} out\n`)),
    error: (message) => process.stderr.write(`${red("error")} ${message}\n`),
  };
}

function ndjsonEmitter(): Emit {
  const write = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  return {
    text: (chunk) => write({ type: "text", text: chunk }),
    reasoning: (chunk) => write({ type: "reasoning", text: chunk }),
    tool: (name, phase, detail, isError) =>
      write({ type: "tool", name, phase, detail, isError: Boolean(isError) }),
    step: (step, max) => write({ type: "step", step, max }),
    usage: (usage) => write({ type: "usage", usage }),
    error: (message) => write({ type: "error", error: message }),
  };
}

async function oneShot(
  prompt: string,
  config: ReturnType<typeof resolveConfig>,
  provider: ReturnType<typeof createProvider>,
  state: ReturnType<typeof createContextState>,
  emit: Emit,
  system: string,
): Promise<void> {
  const messages: Message[] = [{ role: "user", content: prompt }];
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  const result = await runAgent(messages, {
    config,
    provider,
    tools: TOOLS,
    system,
    signal: controller.signal,
    state,
    events: {
      onText: (chunk) => emit.text(chunk),
      onReasoning: (chunk) => emit.reasoning(chunk),
      onToolStart: (name) => emit.tool(name, "start"),
      onToolEnd: (name, result) =>
        emit.tool(name, "end", result.display ?? result.content.slice(0, 80), result.isError),
      onStep: (step, max) => emit.step(step, max),
      onUsage: (usage) => emit.usage(usage),
    },
  });

  state.messages = result.messages;
  if (result.stopReason === "maxSteps") {
    emit.error(`stopped after ${result.steps} steps (--max-steps)`);
  } else if (result.stopReason === "error") {
    emit.error("the provider returned an error mid-turn");
  }
  process.stdout.write("\n");
}

async function interactive(
  config: ReturnType<typeof resolveConfig>,
  state: ReturnType<typeof createContextState>,
  emit: Emit,
  system: string,
): Promise<void> {
  const ready = !config.apiKey && !config.local;

  // The welcome panel replaces the old one-line banner.
  const width = process.stderr.columns ?? 80;
  process.stderr.write(
    renderWelcome(
      {
        version: VERSION,
        workspace: config.workspace,
        provider: config.provider,
        model: config.model,
        isLoggedOut: ready,
      },
      { width },
    ).join("\n"),
  );
  if (ready) {
    process.stderr.write(
      dim(
        "No provider configured. Set HILBRAS_PROVIDER / an API key, or use -p ollama\n" +
          "for a local runtime, before sending a task.\n\n",
      ),
    );
  } else {
    process.stderr.write(dim("Type a task, or /exit to quit. Ctrl-C interrupts a turn.\n\n"));
  }

  const history: Message[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (input === "") {
      rl.prompt();
      continue;
    }
    if (input === "/exit" || input === "/quit") break;
    if (input === "/clear") {
      history.length = 0;
      state.messages = [];
      process.stderr.write(dim("conversation cleared\n"));
      rl.prompt();
      continue;
    }
    if (input === "/context") {
      const rows = state.messages.map((m, i) => `  [${i}] ${m.role} — ${m.content.length} chars`);
      process.stderr.write(dim(`messages: ${state.messages.length}\n${rows.join("\n")}\n`));
      rl.prompt();
      continue;
    }
    if (input === "/help") {
      writeHelp(config, emit);
      rl.prompt();
      continue;
    }

    // Build the provider only once a task is actually submitted, so the panel
    // and the slash commands work with nothing configured.
    let provider: Provider;
    try {
      provider = createProvider(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit.error(message);
      const hint = localRuntimeHint(config.provider);
      if (hint) process.stderr.write(dim(`${hint}\n`));
      process.stderr.write(dim("configure a provider, then try again\n\n"));
      rl.prompt();
      continue;
    }

    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);

    const result = await runAgent([...history, { role: "user", content: input }], {
      config,
      provider,
      tools: TOOLS,
      system,
      signal: controller.signal,
      state,
      events: {
        onText: (chunk) => emit.text(chunk),
        onReasoning: (chunk) => emit.reasoning(chunk),
        onToolStart: (name) => emit.tool(name, "start"),
        onToolEnd: (name, r) =>
          emit.tool(name, "end", r.display ?? r.content.slice(0, 80), r.isError),
        onStep: (step, max) => emit.step(step, max),
        onUsage: (usage) => emit.usage(usage),
      },
    });

    process.off("SIGINT", onSigint);
    history.length = 0;
    history.push(...result.messages);
    state.messages = result.messages;
    process.stdout.write("\n\n");
    rl.prompt();
  }
  rl.close();
  process.stdout.write("\n");
}

const RED = "[31m";
const GREEN = "[32m";
const CYAN = "[36m";
const DIM = "[2m";
const RESET = "[0m";

const red = (s: string) => `${RED}${s}${RESET}`;
const green = (s: string) => `${GREEN}${s}${RESET}`;
const cyan = (s: string) => `${CYAN}${s}${RESET}`;
const dim = (s: string) => `${DIM}${s}${RESET}`;

/**
 * Exit quietly when the output pipe closes (`hilbras-code --list-tools | head`).
 * Without this the process dies on an unhandled EPIPE and prints a stack trace,
 * which is noise in a pipeline and hides the real exit status.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

main();
