import { isLocalProvider, providerKeyEnvVars } from "../config/resolve.ts";
import type { Config, Provider } from "../types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAICompatProvider } from "./openai-compat.ts";

/** Vendors that speak the OpenAI Chat Completions wire format. */
const OPENAI_COMPATIBLE: Record<string, { baseUrl: string; sendAuthHeader: boolean }> = {
  openai: { baseUrl: "https://api.openai.com/v1", sendAuthHeader: true },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", sendAuthHeader: true },
  groq: { baseUrl: "https://api.groq.com/openai/v1", sendAuthHeader: true },
  mistral: { baseUrl: "https://api.mistral.ai/v1", sendAuthHeader: true },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", sendAuthHeader: true },
  xai: { baseUrl: "https://api.x.ai/v1", sendAuthHeader: true },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", sendAuthHeader: false },
  llamacpp: { baseUrl: "http://127.0.0.1:8080/v1", sendAuthHeader: false },
};

export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "groq",
  "mistral",
  "deepseek",
  "xai",
  "ollama",
  "lmstudio",
  "llamacpp",
] as const;

export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

export function isSupportedProvider(name: string): name is ProviderName {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(name.toLowerCase());
}

/**
 * Build a provider from resolved config.
 *
 * Local providers get a helpful error when the runtime is not reachable,
 * because "connection refused" from a bare fetch tells the user nothing.
 */
export function createProvider(config: Config): Provider {
  const provider = config.provider.toLowerCase();
  const model = config.model;

  if (provider === "anthropic") {
    if (!config.apiKey) {
      throw new Error(`missing API key: set ${providerKeyEnvVars("anthropic").join(" or ")}`);
    }
    return new AnthropicProvider(config.apiKey, model, config.baseUrl);
  }

  if (provider === "ollama") {
    return new OllamaProvider(model, config.baseUrl ?? "http://127.0.0.1:11434");
  }

  const compat = OPENAI_COMPATIBLE[provider];
  if (compat) {
    if (!config.apiKey && compat.sendAuthHeader) {
      throw new Error(`missing API key: set ${providerKeyEnvVars(provider).join(" or ")}`);
    }
    return new OpenAICompatProvider({
      name: provider,
      baseUrl: config.baseUrl ?? compat.baseUrl,
      apiKey: config.apiKey,
      model,
      sendAuthHeader: compat.sendAuthHeader,
    });
  }

  throw new Error(
    `unknown provider "${config.provider}". supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
  );
}

/** Human-readable hint shown when a local runtime is not running. */
export function localRuntimeHint(provider: string): string {
  switch (provider) {
    case "ollama":
      return "start it with: ollama serve";
    case "lmstudio":
      return "start the local server in LM Studio (Developer tab)";
    case "llamacpp":
      return "start it with: llama-server -m model.gguf --port 8080";
    default:
      return isLocalProvider(provider) ? "start the local runtime" : "";
  }
}
