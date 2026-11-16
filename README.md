# Legal Notice Studio — local LLM service

Your own AI model for Legal Notice Studio, running on your own machine: no API key, no per-call cost, and no notice text leaving the computer.

> **Status: built and tested, not connected yet.** The app still uses the Claude API. This service is kept separate so the app keeps working while your model is set up. Switching later is a small change that has already been tested (see [Switch the app to your model](#switch-the-app-to-your-model)).

It serves the app in
[legal-studio-notice-backend](https://github.com/1Nishtha/legal-studio-notice-backend) (with the web
app in [legal-studio-notice-frontend](https://github.com/1Nishtha/legal-studio-notice-frontend)).
Paths like `../legal-notice-studio-backend/…` below assume the two are checked out side by side.

## How it works

```
today:   backend AI step ──► Claude API

later:   backend AI step ──► this service (127.0.0.1:4100) ──► Ollama ──► your models
                              │
                              ├─ picks the model for the step (fast / balanced / capable / vision)
                              ├─ writes the JSON structure into the prompt, constrains the answer to it
                              ├─ validates every answer, asks once more if it doesn't match
                              ├─ keeps prompt + answer inside the context window
                              └─ scans: renders PDF pages / shrinks photos, reads them page by page
```

The service accepts exactly the request the backend already builds for Claude: system prompt, document content and JSON schema. It answers in the same shape, with the same error kinds. The backend's retry rules and its "hand it to a person" fallbacks therefore work unchanged.

**Your model** is two named models, defined in [models/](models/):

| Name | Does | Built from (default) | Licence of the base |
|---|---|---|---|
| `legal-notice-reviewer` | triage, fact extraction with quotes, summaries, task plans, draft letters | Qwen3 4B | Apache-2.0 |
| `legal-notice-reader` | reads scanned pages and phone photos | Gemma 3 4B | Gemma Terms of Use |

Both are sized for this laptop's 4 GB GPU (RTX 2050). Ollama moves part of a model to the CPU when the GPU is full; that works, just more slowly. Check the licence of any base model before commercial use.

## Set up the models

1. **Install Ollama** (free, open source) from https://ollama.com/download. It runs in the background at `http://127.0.0.1:11434`.
   *Optional, for a 4 GB GPU:* set the Windows environment variables `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`, then restart Ollama. This roughly halves the memory the context window needs.
2. **Create your two models.** The first time, Ollama downloads the base models (a few GB each):
   ```bash
   cd legal-notice-studio-llm
   ollama create legal-notice-reviewer -f models/legal-notice-reviewer.Modelfile
   ollama create legal-notice-reader -f models/legal-notice-reader.Modelfile
   ```
3. **Check them**: the runtime, the models, one small answer per tier, and the speed on this machine.
   ```bash
   npm install
   npm run check
   npm run check -- --vision ../legal-notice-studio-backend/samples/synthetic/pdfs/04_sample_osha_citation_deep_ellum.pdf
   ```
4. **Run the service:**
   ```bash
   npm run dev        # http://127.0.0.1:4100
   ```

To try the plumbing with no model installed, set `RUNTIME=mock` in `.env`. Answers are then empty placeholders that match the schema, so use it only to test the wiring.

## Choosing models

Change the `FROM` line in a Modelfile and run the same `ollama create` command again, or put any installed model name in `.env` (`MODEL_FAST`, `MODEL_BALANCED`, `MODEL_CAPABLE`, `MODEL_VISION`).

| Option | Size at 4-bit | On a 4 GB GPU | Licence |
|---|---|---|---|
| `qwen3:4b` (default text) | ~2.5 GB | mostly on GPU | Apache-2.0 |
| `qwen2.5:7b` (more accurate text) | ~4.7 GB | split GPU/CPU, slower | Apache-2.0 |
| `phi4-mini` | ~2.5 GB | mostly on GPU | MIT |
| `gemma3:4b` (default vision) | ~3.3 GB | mostly on GPU | Gemma Terms of Use |
| `qwen2.5vl:7b` (stronger OCR) | ~6 GB | split GPU/CPU, slower | Apache-2.0 |
| `granite3.2-vision` (fastest vision) | ~2.4 GB | on GPU | Apache-2.0 |

A local 4B model is less accurate and much slower than Claude, and has not been measured on this laptop yet. `npm run check` shows the speed, and the backend's eval (below) shows the accuracy. Since every value must carry a verified quote, a weaker model mostly produces more fields for people to review rather than wrong deadlines.

## API

`POST /v1/generate` — the backend's `LlmRequest`, plus an optional `tier`:

```json
{
  "step": "extract",
  "tier": "balanced",
  "system": "…instructions…",
  "content": [
    { "type": "text", "text": "<document id=\"D1\">[[page:1]] …</document> Extract the facts." },
    { "type": "pdf", "base64": "…" },
    { "type": "image", "base64": "…", "mediaType": "image/jpeg" }
  ],
  "schema": { "type": "object", "properties": { … } },
  "maxTokens": 8000
}
```

`step` is one of `triage`, `extract`, `extract_rerun`, `transcribe`, `summary`, `plan`, `draft` or `assistant`. Without `tier`, triage uses `fast`, scans use `vision`, re-runs and drafts use `capable`, and everything else uses `balanced`. For `transcribe`, every PDF page and image is read separately, and the answer is `{ "pages": [{ "page", "text" }], "legibility" }`. Other steps cannot see images, so scan attachments are dropped with a note and the transcribed text is used instead.

Answer (the backend's `LlmResult` shape):

```json
{ "json": { … }, "model": "legal-notice-reviewer", "servedBy": "legal-notice-reviewer:latest",
  "stopReason": "end_turn", "usage": { "input": 5210, "output": 812, "cacheRead": 0, "cacheWrite": 0 },
  "latencyMs": 41250, "fallbackUsed": false, "runtime": "ollama", "tier": "balanced", "attempts": 1 }
```

Errors return `{ "error": { "kind", "message", "retryable" } }`. The kinds are the backend's: `not_configured`, `max_tokens`, `invalid_json`, `bad_request`, `auth`, `rate_limit`, `overloaded`, `timeout`, `api`.

Other endpoints:
- `GET /health`: is the runtime reachable, which models are missing, and the exact command to create them.
- `GET /v1/models`: the tier-to-model mapping and the installed models.

If `LLM_SERVICE_TOKEN` is set, every request needs `Authorization: Bearer <token>`. The service listens on `127.0.0.1` only by default.

Runtimes (`RUNTIME` in `.env`):

| Value | Runs on |
|---|---|
| `ollama` | Ollama on this machine (default) |
| `openai` | Any OpenAI-compatible server, such as llama.cpp `llama-server`, vLLM or LM Studio, including a GPU server elsewhere (`OPENAI_BASE_URL`, `OPENAI_API_KEY`) |
| `mock` | No model |

## Switch the app to your model

When you're ready, ask Claude Code to "switch the app to my local model". These are the steps. The connector was compiled against the backend and run through all of its AI steps on 2026-11-15:

1. Copy [integration/backend-provider.ts](integration/backend-provider.ts) to `legal-notice-studio-backend/src/ai/local.ts`.
2. In `legal-notice-studio-backend/src/ai/run.ts`, choose the provider from `AI_PROVIDER`:
   ```ts
   let provider: LlmProvider = config.AI_PROVIDER === "local" ? new LocalLlmProvider() : new AnthropicProvider();
   ```
3. In `legal-notice-studio-backend/.env`, set `AI_PROVIDER=local`. Set `LOCAL_LLM_URL`, `LOCAL_LLM_TOKEN` and `LOCAL_LLM_TIMEOUT_MS` only if they differ from the defaults.
4. Make the AI status in the app show the local model names. Today it lists the Claude models.
5. The backend re-queues jobs that run longer than 10 minutes. If long scans take longer on this laptop, raise that window in `src/workflow/queue.ts`.
6. Run `npm run eval` in the backend with both providers and compare the results against the release gates before trusting it with real notices.

## Making it truly yours

Right now "your model" is an open model with your configuration. To make it learn from your notices:

1. **Collect.** Every notice your team verifies in the app becomes a labelled example: the document text, plus the facts a person confirmed or corrected.
2. **Export.** Turn those into training pairs (document → verified JSON). This export script still needs to be written once there is enough verified data, ideally a few hundred notices.
3. **Fine-tune.** Run a LoRA fine-tune of the base model. This is better done on a larger GPU or a rented cloud GPU than on a 4 GB laptop. Export the result to GGUF.
4. **Swap it in.** Change `FROM` in `models/legal-notice-reviewer.Modelfile` to the new file and run `ollama create` again. Nothing else changes.
5. **Measure.** Use the backend's eval and switch only if it passes the release gates.

Build the training data from facts your reviewers verified. Anthropic's terms restrict using Claude's outputs to train other AI models, so check the current terms before reusing raw Claude answers.

## Tests

```bash
npm test          # 32 tests: runtimes (fake HTTP), JSON repair, schema outline,
                  # tier routing, context guard, PDF page rendering, photo scaling, HTTP API
npm run typecheck
```
