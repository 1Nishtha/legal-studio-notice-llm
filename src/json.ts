/**
 * Lenient parsing of model output: code fences, prose around the object, trailing commas.
 * Structured-output runtimes usually return clean JSON; this covers the ones that do not.
 */
import { ServiceError } from "./errors.js";

export function parseModelJson(raw: string): unknown {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const candidates: string[] = [text];
  const start = text.search(/[{[]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of [...candidates]) candidates.push(c.replace(/,\s*([}\]])/g, "$1"));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  throw new ServiceError("invalid_json", "Model output was not valid JSON", true, { sample: raw.slice(0, 300) });
}
