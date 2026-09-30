# Hilbras Code

A coding agent for your terminal. It reads your repository, edits files, runs commands, and
shows its work — against cloud models or a local runtime, on macOS, Linux, or Windows.

```bash
npm install -g hilbras-code

export ANTHROPIC_API_KEY=sk-ant-...      # or OPENAI_API_KEY, OPENROUTER_API_KEY, ...
hilbras-code "why is src/auth/session.ts retrying forever?"
```

No Node or Bun required on the target machine — the npm package ships a compiled binary per platform.

## Status

Version 0.1.0. Working today: the agent loop, nine tools, ten providers, one-shot and interactive
modes, and a per-platform compiled binary.

Not yet built, and not present in this release:

- **MCP client support.** No `@modelcontextprotocol/sdk` in the bundle. Planned; the plugin seam
  (`Tool` in `src/tools/define.ts`) is where it will attach.
- **A TUI.** Output is a readable transcript, not a full-screen interface. Streaming and tool
  events are already emitted as NDJSON via `--json`, so a TUI can be layered on without changing
  the agent.
- **Parser-based edits** (tree-sitter). Edits today are exact-match with a uniqueness requirement —
  which catches the dangerous failures, but cannot yet make a structurally-aware edit.

## Why this exists

Most coding agents edit files by searching for a string and replacing it. That is fine right up
until the file contains the same string twice, or the file changed since the agent last read it.
Then the agent either corrupts the file or quietly does the wrong thing.

Hilbras Code takes a narrower position on a few things:

- **An edit must be unambiguous.** `edit_file` refuses a replacement whose `old_string` occurs more
  than once, and tells you which lines matched. A refused edit leaves the file untouched.
- **An edit must be current.** A stale `old_string` is a hard error, not a no-op.
- **The agent can see its own context.** `context_status` reports the live token budget, so it stops
  dumping 2000-line files when it is nearly full.
- **The agent reports what it verified.** The system prompt requires it to say what it ran and what
  failed, and to say so plainly when it could not verify something.
- **Tools are typed once.** Each tool is a Zod schema; the same schema validates the model's
  arguments and generates the JSON Schema the model sees. They cannot drift apart.

## Install

```bash
npm install -g hilbras-code
```

Binary names map to platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`,
`windows-x64`. The npm shim picks the right one, and falls back to running from source with Bun
when a platform binary is missing.

To build from source:

```bash
bun install
bun run check      # lint + typecheck + tests
bun run build      # host binary
bun run build:all  # all five targets
```

## Providers

| Provider | Flag | Key |
| --- | --- | --- |
| Anthropic | `-p anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `-p openai` | `OPENAI_API_KEY` |
| OpenRouter | `-p openrouter` | `OPENROUTER_API_KEY` |
| Groq | `-p groq` | `GROQ_API_KEY` |
| Mistral | `-p mistral` | `MISTRAL_API_KEY` |
| DeepSeek | `-p deepseek` | `DEEPSEEK_API_KEY` |
| xAI | `-p xai` | `XAI_API_KEY` |
| Ollama | `-p ollama` | none (local) |
| LM Studio | `-p lmstudio` | none (local) |
| llama.cpp | `-p llamacpp` | none (local) |

```bash
hilbras-code --list-providers
hilbras-code --list-tools
```

Local runtimes need no key at all:

```bash
ollama serve
hilbras-code -p ollama -m qwen2.5-coder "add tests for the retry helper"
```

## Usage

```bash
hilbras-code                                    # interactive session
hilbras-code "fix the failing parser test"       # one-shot
hilbras-code -p openai -m gpt-4o "review the diff"
hilbras-code --json "list the TODO comments"     # NDJSON events for scripting
hilbras-code -w ../other-repo "port the config loader"
```

In an interactive session: `/context` shows the conversation breakdown, `/clear` resets it,
`/exit` quits. Ctrl-C interrupts a turn rather than killing the process.

### Configuration

Resolved in this order — later wins:

1. CLI flags
2. `HILBRAS_PROVIDER`, `HILBRAS_MODEL`, `HILBRAS_BASE_URL`, `HILBRAS_MAX_TOKENS`,
   `HILBRAS_TEMPERATURE`, `HILBRAS_MAX_STEPS`
3. the provider's own key variable
4. `hilbras-code.json` in the workspace
5. built-in defaults

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "maxSteps": 50,
  "temperature": 0
}
```

## Built-in tools

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file with line numbers; paginate large files |
| `write_file` | Create or replace a file |
| `edit_file` | Replace a unique exact snippet; refuses ambiguity |
| `run_shell` | Run a command in the workspace (git, builds, tests) |
| `search_files` | Find files by glob |
| `grep` | Search file contents by regex |
| `list_dir` | List a directory |
| `git` | Read-only git: status, diff, log, show, branch, blame |
| `context_status` | Report token budget and the largest messages |

Reads run concurrently; writes and shell commands are serialised in call order.

## Architecture

```
src/
  types.ts              provider-agnostic contracts
  cli.ts                argument parsing, emitters, interactive loop
  config/resolve.ts     layered config resolution
  agent/loop.ts         the turn loop: stream → tools → repeat
  providers/            anthropic, openai-compat, ollama, http (SSE + NDJSON)
  tools/                define (Zod), files, shell, agent-tools
```

`Provider` is the seam. Anthropic, the seven OpenAI-compatible vendors, and Ollama normalise into
the same `Message` / `ToolCall` / `StreamEvent` shapes, so the agent loop never learns a vendor's
wire format. Adding a provider means one file.

## Development

```bash
bun test                              # unit + SSE-level end-to-end tests
bun test tests/providers.e2e.test.ts  # real HTTP streaming against a local server
bun run typecheck
bun run lint
```

The end-to-end tests run a local HTTP server that speaks the real Anthropic and OpenAI streaming
protocols, so the SSE framing, tool-call accumulation, and usage merging are covered by execution
rather than by mock expectations.

## License

MIT
