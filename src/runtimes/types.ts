/** A runtime is whatever actually runs the model: Ollama, an OpenAI-compatible server, or the mock. */
export interface RuntimeImage {
  base64: string;
  mime: "image/png" | "image/jpeg";
}

export interface RuntimeMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: RuntimeImage[];
}

export interface RuntimeRequest {
  model: string;
  messages: RuntimeMessage[];
  /** JSON schema the runtime should constrain the answer to. */
  schema: Record<string, unknown>;
  maxTokens: number;
  temperature: number;
  numCtx: number;
  timeoutMs: number;
  disableThinking: boolean;
}

export interface RuntimeResult {
  text: string;
  model: string;
  stopReason: "end_turn" | "max_tokens";
  inputTokens: number;
  outputTokens: number;
}

export interface Runtime {
  readonly name: string;
  readonly baseUrl: string;
  chat(req: RuntimeRequest): Promise<RuntimeResult>;
  /** Installed/served model names; "*" means "any name works" (mock). */
  listModels(): Promise<string[]>;
  version(): Promise<string | null>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
