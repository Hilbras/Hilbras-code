import type { Config } from "../types.ts";

/**
 * Config resolution order (later wins):
 *   1. defaults below
 *   2. config file (hilbras-code.json / .hilbrasrc.json in the workspace)
 *   3. environment variables
 *   4. CLI flags (applied by the caller, not here)
 */

const DEFAULTS = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 8192,
  temperature: 0,
  maxSteps: 50,
  local: false,
  followMode: true,
} as const;

/** Env var names accepted for each provider, in priority order. */
const PROVIDER_KEY_VARS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  xai: ["XAI_API_KEY"],
  ollama: [],
  lmstudio: [],
  llamacpp: [],
};

export function providerKeyEnvVars(provider: string): string[] {
  return PROVIDER_KEY_VARS[provider.toLowerCase()] ?? [];
}

/** Providers that need no API key because they run against a local runtime. */
export const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llamacpp"]);

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider.toLowerCase());
}

function readConfigFile(workspace: string): Partial<Config> {
  const candidates = [`${workspace}/hilbras-code.json`, `${workspace}/.hilbrasrc.json`];
  for (const path of candidates) {
    try {
      const text = require("node:fs").readFileSync(path, "utf8") as string;
      const parsed = JSON.parse(text) as Partial<Config>;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      // Missing or unreadable config is not an error; env and flags still apply.
    }
  }
  return {};
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  workspace: string = process.cwd(),
): Config {
  const file = readConfigFile(workspace);
  const provider = (env.HILBRAS_PROVIDER ?? file.provider ?? DEFAULTS.provider).toLowerCase();
  const localFlag = env.HILBRAS_LOCAL === "1" || env.HILBRAS_LOCAL === "true";

  return {
    provider,
    model: env.HILBRAS_MODEL ?? file.model ?? DEFAULTS.model,
    baseUrl: env.HILBRAS_BASE_URL ?? file.baseUrl,
    apiKey: firstApiKey(env, provider),
    maxTokens: intOr(env.HILBRAS_MAX_TOKENS, file.maxTokens, DEFAULTS.maxTokens),
    temperature: floatOr(env.HILBRAS_TEMPERATURE, file.temperature, DEFAULTS.temperature),
    local: localFlag || isLocalProvider(provider),
    workspace,
    followMode: boolOr(env.HILBRAS_FOLLOW, file.followMode, DEFAULTS.followMode),
    maxSteps: intOr(env.HILBRAS_MAX_STEPS, file.maxSteps, DEFAULTS.maxSteps),
  };
}

function firstApiKey(env: NodeJS.ProcessEnv, provider: string): string | undefined {
  for (const name of providerKeyEnvVars(provider)) {
    const value = env[name];
    if (value && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function intOr(raw: string | undefined, fromFile: number | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  if (typeof fromFile === "number" && Number.isFinite(fromFile)) return fromFile;
  return fallback;
}

function floatOr(raw: string | undefined, fromFile: number | undefined, fallback: number): number {
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  if (typeof fromFile === "number" && Number.isFinite(fromFile)) return fromFile;
  return fallback;
}

function boolOr(
  raw: string | undefined,
  fromFile: boolean | undefined,
  fallback: boolean,
): boolean {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  if (typeof fromFile === "boolean") return fromFile;
  return fallback;
}
