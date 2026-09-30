import { execa } from "execa";
import { z } from "zod";
import { type Tool, type ToolContext, defineTool, failure, success } from "./define.ts";

/**
 * Shell, search, and git tools.
 *
 * The shell tool is deliberately not sandboxed by default — an agent that
 * cannot run the tests it just wrote is not much of a coding agent — but the
 * workspace is prepended to PATH-local git and the timeout is hard-capped so a
 * runaway build cannot wedge the session.
 */

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 30_000;

export const shellTool = defineTool({
  name: "run_shell",
  description:
    "Run a shell command in the workspace. Use it for git, package managers, " +
    "builds and tests. Prefer a non-interactive command; never pass a command " +
    "that waits for input.",
  schema: z.object({
    command: z.string().describe("The command to run"),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(MAX_TIMEOUT)
      .optional()
      .describe(`Timeout in ms (default ${DEFAULT_TIMEOUT})`),
  }),
  concurrent: false,
  destructive: true,
  execute: async (input, ctx) => {
    const started = Date.now();
    try {
      const result = await execa("bash", ["-lc", input.command], {
        cwd: ctx.workspace,
        timeout: input.timeout_ms ?? DEFAULT_TIMEOUT,
        env: { ...process.env, CI: "1", NO_COLOR: "1" },
        reject: false,
      });

      const stdout = clip(result.stdout ?? "");
      const stderr = clip(result.stderr ?? "");
      const duration = Date.now() - started;
      const combined = [stdout, stderr].filter((part) => part !== "").join("\n");

      if (result.exitCode === 0) {
        return success(
          combined === "" ? `Command succeeded (exit 0, no output, ${duration}ms).` : combined,
          `$ ${input.command}\n${combined}`.slice(0, 2000),
        );
      }
      return {
        content: `Command failed (exit ${result.exitCode}, ${duration}ms).\n${combined}`,
        display: `$ ${input.command}  → exit ${result.exitCode}`,
        isError: true,
      };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  },
});

export const searchFilesTool = defineTool({
  name: "search_files",
  description:
    "Find files by glob pattern (e.g. '**/*.ts'). Use this to locate code before reading it.",
  schema: z.object({
    pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'"),
    path: z.string().optional().describe("Directory to search under (default: workspace)"),
    limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
  }),
  execute: async (input, ctx) => {
    const root = input.path ? `${ctx.workspace}/${input.path}` : ctx.workspace;
    const glob = new Bun.Glob(input.pattern);
    const matches: string[] = [];
    const limit = input.limit ?? 100;

    try {
      for await (const entry of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
        matches.push(entry);
        if (matches.length >= limit) break;
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    if (matches.length === 0) {
      return success(`No files matched ${input.pattern}.`, "no matches");
    }
    const shown = matches.map((m) => `  ${m}`).join("\n");
    const note = matches.length >= limit ? `\n[stopped at ${limit} matches]` : "";
    return success(
      `${matches.length} file(s) matched ${input.pattern}:\n${shown}${note}`,
      `search ${input.pattern}: ${matches.length} match(es)`,
    );
  },
});

export const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns matching lines with " +
    "file:line prefixes. Use this to find where something is defined or used.",
  schema: z.object({
    pattern: z.string().describe("Regular expression to search for"),
    path: z.string().optional().describe("Directory to search (default: workspace)"),
    glob: z.string().optional().describe("Restrict to files matching this glob"),
    case_insensitive: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(200).optional().describe("Max matches (default 60)"),
  }),
  execute: async (input, ctx) => {
    const root = input.path ? `${ctx.workspace}/${input.path}` : ctx.workspace;
    const limit = input.limit ?? 60;
    const flags = input.case_insensitive ? "i" : "";
    const globArg = input.glob ? `--glob=${JSON.stringify(input.glob)}` : "";

    // ripgrep is preferred; grep -r is the portable fallback so the tool still
    // works on a machine with no rg installed.
    const hasRg = await commandExists("rg");
    const command = hasRg
      ? `rg ${flags ? `--${flags} ` : ""}--line-number --no-heading --color=never ${shellQuote(input.pattern)} ${globArg} . | head -n ${limit}`
      : `grep -rnE ${input.case_insensitive ? "-i " : ""}${shellQuote(input.pattern)} ${globArg ? `--include=${shellQuote((input.glob as string) || "*")} ` : ""}. 2>/dev/null | head -n ${limit}`;

    try {
      const out = await execa("bash", ["-lc", command], {
        cwd: root,
        timeout: 30_000,
        reject: false,
        env: { ...process.env, NO_COLOR: "1" },
      });
      const text = clip((out.stdout ?? "").trim());
      if (text === "") return success(`No matches for ${input.pattern}.`, "no matches");
      return success(text, `grep ${input.pattern}: ${text.split("\n").length} match(es)`);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  },
});

export const listDirTool = defineTool({
  name: "list_dir",
  description: "List the entries of a directory. Use it to orient before reading files.",
  schema: z.object({
    path: z.string().optional().describe("Directory to list (default: workspace root)"),
  }),
  execute: async (input, ctx) => {
    const dir = input.path ? `${ctx.workspace}/${input.path}` : ctx.workspace;
    const entries = [...new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false })].sort();
    if (entries.length === 0) return success(`${dir} is empty.`, `${input.path ?? "."} (empty)`);
    return success(entries.join("\n"), `list ${input.path ?? "."}: ${entries.length} entries`);
  },
});

/**
 * Read-only git helper. The agent can always fall back to run_shell for
 * anything exotic, but having history/diff as first-class tools means the
 * common cases do not burn a shell round-trip.
 */
export const gitTool = defineTool({
  name: "git",
  description:
    "Run a read-only git command. Supports status, diff, log, show, and branch. " +
    "For anything mutating, use run_shell so the action is visible in the transcript.",
  schema: z.object({
    subcommand: z
      .enum(["status", "diff", "log", "show", "branch", "blame"])
      .describe("Git subcommand to run"),
    path: z.string().optional().describe("Restrict diff/show to this path"),
    ref: z.string().optional().describe("Ref for log/show (default HEAD)"),
    stat_only: z.boolean().optional().default(false).describe("For diff: summary only"),
  }),
  concurrent: false,
  execute: async (input, ctx) => {
    const args: string[] = [input.subcommand];
    if (input.subcommand === "log") {
      args.push("--oneline", "-n", "20", input.ref ?? "HEAD");
    }
    if (input.subcommand === "diff" || input.subcommand === "show") {
      if (input.stat_only) args.push("--stat");
      if (input.subcommand === "diff") args.push(input.ref ?? "HEAD");
      else args.push(input.ref ?? "HEAD");
    }
    if (input.path) args.push("--", input.path);

    return runGit(args, ctx);
  },
});

export const shellTools: Tool[] = [shellTool, searchFilesTool, grepTool, listDirTool, gitTool];

async function runGit(args: string[], ctx: ToolContext) {
  try {
    const out = await execa("git", args, { cwd: ctx.workspace, reject: false, timeout: 30_000 });
    const stdout = clip((out.stdout ?? "").trim());
    const stderr = (out.stderr ?? "").trim();
    if (out.exitCode !== 0) {
      return failure(`git ${args.join(" ")} failed: ${stderr || `exit ${out.exitCode}`}`);
    }
    return success(stdout === "" ? "(no output)" : stdout, `git ${args[0]}: ok`);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

let rgCache: boolean | null = null;

async function commandExists(command: string): Promise<boolean> {
  if (command === "rg" && rgCache !== null) return rgCache;
  try {
    const out = await execa("bash", ["-lc", `command -v ${command}`], { reject: false });
    const found = out.exitCode === 0;
    if (command === "rg") rgCache = found;
    return found;
  } catch {
    return false;
  }
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more chars)`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
