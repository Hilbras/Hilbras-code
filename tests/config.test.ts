import { describe, expect, test } from "bun:test";
import { isLocalProvider, providerKeyEnvVars, resolveConfig } from "../src/config/resolve.ts";
import { contextTool, createContextState, estimateTokens } from "../src/tools/agent-tools.ts";

const clean = (extra: Record<string, string> = {}) => ({ ...extra }) as NodeJS.ProcessEnv;

describe("resolveConfig", () => {
  test("defaults to anthropic with a sane model", () => {
    const config = resolveConfig(clean(), "/tmp");
    expect(config.provider).toBe("anthropic");
    expect(config.maxSteps).toBe(50);
    expect(config.temperature).toBe(0);
  });

  test("reads the provider's own key var", () => {
    const config = resolveConfig(clean({ ANTHROPIC_API_KEY: "sk-ant-1" }), "/tmp");
    expect(config.apiKey).toBe("sk-ant-1");
  });

  test("does not leak a key from a different provider", () => {
    const config = resolveConfig(
      clean({ ANTHROPIC_API_KEY: "sk-ant-1", HILBRAS_PROVIDER: "openai" }),
      "/tmp",
    );
    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBeUndefined();
  });

  test("explicit HILBRAS_PROVIDER wins over the default", () => {
    const config = resolveConfig(
      clean({ HILBRAS_PROVIDER: "openrouter", HILBRAS_MODEL: "x/y" }),
      "/tmp",
    );
    expect(config.provider).toBe("openrouter");
    expect(config.model).toBe("x/y");
  });

  test("numeric env vars are parsed and bad values fall back", () => {
    expect(resolveConfig(clean({ HILBRAS_MAX_STEPS: "12" }), "/tmp").maxSteps).toBe(12);
    expect(resolveConfig(clean({ HILBRAS_MAX_STEPS: "abc" }), "/tmp").maxSteps).toBe(50);
  });

  test("local providers are flagged and need no key", () => {
    const config = resolveConfig(clean({ HILBRAS_PROVIDER: "ollama" }), "/tmp");
    expect(config.local).toBe(true);
    expect(config.apiKey).toBeUndefined();
  });

  test("a config file supplies defaults below env", async () => {
    const dir = `${import.meta.dir}/../.tmp-test-config`;
    await Bun.write(`${dir}/hilbras-code.json`, JSON.stringify({ provider: "groq", maxSteps: 7 }));
    const config = resolveConfig(clean(), dir);
    expect(config.provider).toBe("groq");
    expect(config.maxSteps).toBe(7);
    // env still outranks the file
    expect(resolveConfig(clean({ HILBRAS_PROVIDER: "xai" }), dir).provider).toBe("xai");
  });
});

describe("provider metadata", () => {
  test("knows which providers are local", () => {
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("anthropic")).toBe(false);
  });

  test("maps provider names to their key env vars", () => {
    expect(providerKeyEnvVars("anthropic")).toContain("ANTHROPIC_API_KEY");
    expect(providerKeyEnvVars("ollama")).toEqual([]);
  });
});

describe("context_status", () => {
  test("reports token usage against the window", async () => {
    const state = createContextState(1000, [{ role: "user", content: "a".repeat(3600) }]);
    const result = await contextTool.execute({ detail: "summary" }, { workspace: "/tmp", state });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1000");
    expect(result.content).toContain("Remaining");
  });

  test("per-message detail lists each message", async () => {
    const state = createContextState(10_000, [
      { role: "user", content: "first message" },
      { role: "assistant", content: "second message" },
    ]);
    const result = await contextTool.execute({ detail: "messages" }, { workspace: "/tmp", state });
    expect(result.content).toContain("user");
    expect(result.content).toContain("assistant");
  });

  test("warns when the budget is tight", async () => {
    const state = createContextState(100, [{ role: "user", content: "x".repeat(2000) }]);
    const result = await contextTool.execute({ detail: "summary" }, { workspace: "/tmp", state });
    expect(result.content).toContain("tight");
  });

  test("degrades honestly when no state is bound", async () => {
    const result = await contextTool.execute({ detail: "summary" }, { workspace: "/tmp" });
    expect(result.content).toContain("not bound");
  });

  test("estimates tokens from text length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(360))).toBe(100);
  });
});
