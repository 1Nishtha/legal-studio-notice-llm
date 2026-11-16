/** Small fetch wrapper: timeouts and "server not running" become ServiceErrors the caller can retry. */
import { ServiceError } from "../errors.js";
import type { FetchLike } from "./types.js";

export interface HttpResult {
  status: number;
  json: unknown;
  text: string;
}

export async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: { method: "GET" | "POST"; body?: unknown; headers?: Record<string, string>; timeoutMs: number },
  label: string,
): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: init.method,
      headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (e) {
    throw networkError(e, url, label, init.timeoutMs);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw networkError(e, url, label, init.timeoutMs);
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body (error page); keep the text
  }
  return { status: res.status, json, text };
}

function networkError(e: unknown, url: string, label: string, timeoutMs: number): ServiceError {
  const err = e as Error & { cause?: { code?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new ServiceError("timeout", `${label} did not answer within ${Math.round(timeoutMs / 1000)} s`, true);
  }
  const code = err?.cause?.code ?? err?.message ?? "unknown error";
  return new ServiceError("overloaded", `${label} is not reachable at ${new URL(url).origin} (${code}) — is it running?`, true);
}

export function errorMessage(json: unknown, text: string): string {
  const j = json as { error?: string | { message?: string } } | null;
  if (typeof j?.error === "string") return j.error;
  if (j?.error && typeof j.error === "object" && typeof j.error.message === "string") return j.error.message;
  return text.slice(0, 300) || "no details";
}
