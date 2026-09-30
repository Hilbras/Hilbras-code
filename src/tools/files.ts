import { z } from "zod";
import { type Tool, defineTool, failure, success } from "./define.ts";

/**
 * File tools: read, write, and structural edit.
 *
 * `edit` is the one that matters. A blind string replace on a 4000-line file
 * that contains the same line twice is how agents corrupt files; here the
 * replacement is anchored to a unique match, and the match must be exact and
 * occur once. That single constraint removes the most common class of
 * silent damage, and it is why `old_string` is required rather than optional.
 */

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 400_000;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a file from the workspace. Returns content with 1-indexed line numbers. " +
    "For large files pass offset/limit to page through them.",
  schema: z.object({
    path: z.string().describe("File path, absolute or relative to the workspace root"),
    offset: z.number().int().min(1).optional().describe("1-indexed line to start from"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_READ_LINES)
      .optional()
      .describe("Max lines to return (default 2000)"),
  }),
  execute: async (input, ctx) => {
    const abs = resolve(ctx.workspace, input.path);

    // Bun.file().stat() throws on a missing path, and its `type` field is
    // absent in this runtime — isFile() is the reliable check.
    let file: ReturnType<typeof Bun.file>;
    try {
      file = Bun.file(abs);
      if (!(await file.exists())) return failure(`file not found: ${input.path}`);
    } catch {
      return failure(`cannot read ${input.path}: it may be a directory or unreadable`);
    }

    let whole: string;
    try {
      whole = await file.text();
    } catch {
      return failure(`cannot read ${input.path}: it may be a directory or unreadable`);
    }
    const lines = whole.split("\n");
    const start = (input.offset ?? 1) - 1;
    const slice = lines.slice(start, start + (input.limit ?? MAX_READ_LINES));
    const truncated = start + slice.length < lines.length;

    const numbered = slice
      .map((line, index) => `${String(start + index + 1).padStart(5, " ")}\t${line}`)
      .join("\n");

    if (whole.length > MAX_READ_BYTES && !input.limit) {
      return success(
        `File is large (${whole.length} bytes, ${lines.length} lines). Showing first ${slice.length} lines.`,
        numbered,
      );
    }

    const footer = truncated
      ? `\n\n[${lines.length - (start + slice.length)} more lines; call read_file with offset=${start + slice.length + 1}]`
      : "";
    return success(`${numbered}${footer}`, numbered);
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create a file or replace its entire contents. Parent directories are created. " +
    "Prefer edit_file for changing part of an existing file.",
  schema: z.object({
    path: z.string().describe("File path, absolute or relative to the workspace root"),
    content: z.string().describe("Full new contents of the file"),
  }),
  concurrent: false,
  destructive: true,
  execute: async (input, ctx) => {
    const abs = resolve(ctx.workspace, input.path);
    await Bun.write(abs, input.content);
    const lines = input.content === "" ? 0 : input.content.split("\n").length;
    return success(
      `Wrote ${input.content.length} bytes (${lines} lines) to ${input.path}.`,
      `write ${input.path} (${lines} lines)`,
    );
  },
});

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Replace an exact, unique snippet in a file. old_string must appear EXACTLY once — " +
    "if it appears more than once, include more surrounding context to disambiguate. " +
    "This is safer than rewriting the whole file.",
  schema: z.object({
    path: z.string().describe("File path, absolute or relative to the workspace root"),
    old_string: z.string().describe("Exact text to replace, including indentation"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z
      .boolean()
      .optional()
      .default(false)
      .describe("Replace every occurrence instead of requiring uniqueness"),
  }),
  concurrent: false,
  destructive: true,
  execute: async (input, ctx) => {
    const abs = resolve(ctx.workspace, input.path);

    let content: string;
    try {
      content = await Bun.file(abs).text();
    } catch {
      return failure(`file not found: ${input.path}. Use write_file to create it.`);
    }

    if (input.old_string === input.new_string) {
      return failure("old_string and new_string are identical; nothing to do.");
    }

    const occurrences = countOccurrences(content, input.old_string);
    if (occurrences === 0) {
      return failure(
        `old_string not found in ${input.path}. Read the file again to get the exact current text — watch indentation and trailing whitespace.`,
      );
    }
    if (occurrences > 1 && !input.replace_all) {
      const lines = content.split("\n").filter((line) => line.includes(input.old_string));
      const preview = lines
        .slice(0, 5)
        .map((line, i) => `  ${i + 1}: ${line.trim()}`)
        .join("\n");
      return failure(
        `old_string appears ${occurrences} times in ${input.path}; refusing to guess. ` +
          `Add more surrounding context, or pass replace_all. Matching lines:\n${preview}`,
      );
    }

    const updated =
      input.replace_all === true
        ? content.split(input.old_string).join(input.new_string)
        : content.replace(input.old_string, input.new_string);

    await Bun.write(abs, updated);

    const delta = updated.length - content.length;
    const display = summariseEdit(
      input.path,
      input.old_string,
      input.new_string,
      input.replace_all === true,
    );
    return success(
      `Edited ${input.path} (${occurrences} replacement${occurrences > 1 ? "s" : ""}, ${delta >= 0 ? "+" : ""}${delta} bytes).`,
      display,
    );
  },
});

export const fileTools: Tool[] = [readFileTool, writeFileTool, editFileTool];

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function summariseEdit(path: string, before: string, after: string, all: boolean): string {
  const b = firstLine(before);
  const a = firstLine(after);
  return `edit ${path}${all ? " (all)" : ""}: ${truncate(b, 40)} -> ${truncate(a, 40)}`;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.trim() === "" ? "(blank)" : line.trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function resolve(workspace: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${workspace.replace(/\/+$/, "")}/${path}`;
}
