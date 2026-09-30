import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { editFileTool, readFileTool, writeFileTool } from "../src/tools/files.ts";

const workspace = `${import.meta.dir}/../.tmp-test-files`;
const created: string[] = [];

/** Each test gets its own scratch dir, removed when the file's tests finish. */
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshWorkspace(): Promise<string> {
  const dir = `${workspace}-${Math.random().toString(36).slice(2, 8)}`;
  created.push(dir);
  await Bun.write(`${dir}/.keep`, "");
  return dir;
}

describe("read_file", () => {
  test("returns content with 1-indexed line numbers", async () => {
    const dir = await freshWorkspace();
    await Bun.write(`${dir}/a.txt`, "alpha\nbeta\ngamma\n");

    const result = await readFileTool.execute({ path: "a.txt" }, { workspace: dir });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("    1\talpha");
    expect(result.content).toContain("    3\tgamma");
  });

  test("paginates with offset and limit", async () => {
    const dir = await freshWorkspace();
    await Bun.write(
      `${dir}/n.txt`,
      Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"),
    );

    const result = await readFileTool.execute(
      { path: "n.txt", offset: 3, limit: 2 },
      { workspace: dir },
    );
    expect(result.content).toContain("line3");
    expect(result.content).toContain("line4");
    expect(result.content).not.toContain("line5");
    expect(result.content).toContain("offset=5");
  });

  test("missing file is an error, not a throw", async () => {
    const dir = await freshWorkspace();
    const result = await readFileTool.execute({ path: "nope.txt" }, { workspace: dir });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });
});

describe("write_file", () => {
  test("creates nested directories", async () => {
    const dir = await freshWorkspace();
    const result = await writeFileTool.execute(
      { path: "deep/nested/file.txt", content: "hello" },
      { workspace: dir },
    );
    expect(result.isError).toBeUndefined();
    expect(await Bun.file(`${dir}/deep/nested/file.txt`).text()).toBe("hello");
  });
});

describe("edit_file", () => {
  test("replaces a unique match", async () => {
    const dir = await freshWorkspace();
    await Bun.write(`${dir}/code.ts`, "const a = 1;\nconst b = 2;\n");

    const result = await editFileTool.execute(
      {
        path: "code.ts",
        old_string: "const a = 1;",
        new_string: "const a = 42;",
        replace_all: false,
      },
      { workspace: dir },
    );
    expect(result.isError).toBeUndefined();
    expect(await Bun.file(`${dir}/code.ts`).text()).toBe("const a = 42;\nconst b = 2;\n");
  });

  test("refuses an ambiguous match and names the matching lines", async () => {
    const dir = await freshWorkspace();
    await Bun.write(`${dir}/dup.ts`, "return x;\nfoo();\nreturn x;\n");

    const result = await editFileTool.execute(
      { path: "dup.ts", old_string: "return x;", new_string: "return y;", replace_all: false },
      { workspace: dir },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("appears 2 times");
    // The file must be untouched — a refused edit is a no-op.
    expect(await Bun.file(`${dir}/dup.ts`).text()).toBe("return x;\nfoo();\nreturn x;\n");
  });

  test("replace_all applies to every occurrence", async () => {
    const dir = await freshWorkspace();
    await Bun.write(`${dir}/all.ts`, "x\nx\nx\n");

    const result = await editFileTool.execute(
      { path: "all.ts", old_string: "x", new_string: "y", replace_all: true },
      { workspace: dir },
    );
    expect(result.isError).toBeUndefined();
    expect(await Bun.file(`${dir}/all.ts`).text()).toBe("y\ny\ny\n");
  });

  test("a stale old_string fails instead of corrupting the file", async () => {
    const dir = await freshWorkspace();
    const original = "function f() {\n  return 1;\n}\n";
    await Bun.write(`${dir}/f.ts`, original);

    const result = await editFileTool.execute(
      { path: "f.ts", old_string: "  return 2;", new_string: "  return 3;", replace_all: false },
      { workspace: dir },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("old_string not found");
    expect(await Bun.file(`${dir}/f.ts`).text()).toBe(original);
  });

  test("identical old and new is rejected", async () => {
    const dir = await freshWorkspace();
    await Bun.write(`${dir}/same.ts`, "abc\n");
    const result = await editFileTool.execute(
      { path: "same.ts", old_string: "abc", new_string: "abc", replace_all: false },
      { workspace: dir },
    );
    expect(result.isError).toBe(true);
  });
});
