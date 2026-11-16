import type { Config } from "../config.js";
import { MockRuntime } from "./mock.js";
import { OllamaRuntime } from "./ollama.js";
import { OpenAICompatibleRuntime } from "./openai.js";
import type { Runtime } from "./types.js";

export function createRuntime(config: Config): Runtime {
  switch (config.RUNTIME) {
    case "ollama":
      return new OllamaRuntime(config.OLLAMA_BASE_URL.replace(/\/+$/, ""), config.KEEP_ALIVE);
    case "openai":
      return new OpenAICompatibleRuntime(config.OPENAI_BASE_URL.replace(/\/+$/, ""), config.OPENAI_API_KEY);
    case "mock":
      return new MockRuntime();
  }
}
