/**
 * No model at all: answers with the smallest JSON that matches the schema (empty strings,
 * false, 0, empty lists). For wiring tests and demos of the plumbing — never for real notices.
 * Tests can pass a `responder` to script the answers.
 */
import { exampleFromSchema } from "../schema-tools.js";
import type { Runtime, RuntimeRequest, RuntimeResult } from "./types.js";

export class MockRuntime implements Runtime {
  readonly name = "mock";
  readonly baseUrl = "mock://local";
  readonly calls: RuntimeRequest[] = [];

  constructor(private readonly responder?: (req: RuntimeRequest, callIndex: number) => string | Partial<RuntimeResult> | Promise<string | Partial<RuntimeResult>>) {}

  async chat(req: RuntimeRequest): Promise<RuntimeResult> {
    this.calls.push(req);
    const scripted = this.responder ? await this.responder(req, this.calls.length - 1) : undefined;
    const partial: Partial<RuntimeResult> = typeof scripted === "string" ? { text: scripted } : (scripted ?? {});
    const text = partial.text ?? JSON.stringify(exampleFromSchema(req.schema));
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text,
      model: partial.model ?? `mock:${req.model}`,
      stopReason: partial.stopReason ?? "end_turn",
      inputTokens: partial.inputTokens ?? Math.ceil(promptChars / 4),
      outputTokens: partial.outputTokens ?? Math.ceil(text.length / 4),
    };
  }

  async listModels(): Promise<string[]> {
    return ["*"];
  }

  async version(): Promise<string | null> {
    return "mock";
  }
}
