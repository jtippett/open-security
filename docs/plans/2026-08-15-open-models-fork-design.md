# Open-models fork: design

Date: 2026-08-15. Status: agreed in conversation; implementation on branch
`open-models`.

## Goal

Fork `openai/codex-security` so that open-weight models (GLM, DeepSeek, Kimi,
MiniMax, Qwen) are the default, first-class, cost-tracked experience, while
staying trivially rebaseable on upstream.

## What we learned

- The project is a thin CLI/SDK wrapper around the Codex CLI. The LLM adapter
  _is_ Codex; providers are declared through Codex `model_providers`. No adapter
  swap is needed or wanted.
- Codex removed `wire_api = "chat"` (openai/codex#10157, Feb 2026). Codex 0.147+
  hard-fails at config load on it. Only Responses-API endpoints work. Z.ai (GLM)
  documents Chat Completions only, so direct vendor access is not viable for the
  headline model. DeepSeek and Qwen Cloud document Responses; Moonshot/MiniMax
  probably do (route probe).
- OpenRouter's Responses endpoint works with the shipped code today
  (`--provider openrouter --model z-ai/glm-5.2`), accepts every effort level
  including `xhigh`, and normalizes reasoning params per model.
- The bundled plugin (`_bundled_plugin`) is a build artifact of a private
  OpenAI repo. It is provider-agnostic; we do not modify it.
- OpenAI coupling in the SDK is limited to: provider registry
  (`src/config.ts`), defaults (`src/config.ts`), pricing table
  (`src/cost.ts`), the `--provider` enum and help text (`src/cli.ts`), docs.

## Decisions

1. **OpenRouter is the only route for open models.** It normalizes the
   endpoint. Direct vendor providers may be added later as registry rows
   for vendors that speak Responses (DeepSeek, Qwen Cloud), but not now.
2. **Keep every upstream path.** OpenAI/ChatGPT, OpenRouter, Fireworks,
   Bedrock all continue to work. Changes are additive.
3. **Defaults change.** A bare `codex-security scan .` (and `validate`/`patch`) uses
   `--provider openrouter --model z-ai/glm-5.2` (→ `glm-5.3` when it lands
   on OpenRouter). Default effort stays `xhigh` (verified accepted).
   `--provider openai` restores upstream behaviour, including upstream's
   default model `gpt-5.6-sol`.
4. **Pricing catalog** for the open models, generated from OpenRouter's public
   `/api/v1/models` endpoint by a script (`pnpm generate:pricing`), following
   the existing `generate:models` pattern. Runtime stays offline; the table
   is refreshed at will. Unknown models still degrade to "cost unavailable",
   never to a failed scan.
5. **Rebaseability is a hard constraint.** Fork-specific code is isolated in
   a few named hunks; an upstream-update procedure is documented in
   `docs/UPSTREAM.md`.
6. **Contract robustness for open models.** The spike showed GLM-5.2 finds
   the planted bugs but misses the scan contract: it wrote `scan.artifacts`
   into the SDK-owned draft (the schema marks it required; the prose says
   omit it) and wrote an optional field (`codeEvidence`) in the wrong shape,
   so completion refused to seal. Two fork-only mitigations, both gated on
   external providers so OpenAI scans are byte-identical to upstream:
   - a guidance prologue appended to the scan prompt (SDK-owned rules,
     schema-exactness, no scratch files). A self-check recipe was tried and
     dropped: it made GLM-5.2 read the schemas and finalizer at length
     (run 2: $1.24 / 24 min vs run 1: $0.30 / 11 min + one repair turn);
   - before `complete-scan`, strip model-authored seal fields, validate the
     draft with the plugin's finalizer on a private temporary copy, and when it
     reports a contract error, run a repair turn on the same thread (max 2).
     Neither touches `_bundled_plugin`.

## Changes (planned)

| Area      | File                                                            | Change                                                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Defaults  | `sdk/typescript/src/config.ts`                                  | `DEFAULT_MODEL_PROVIDER = "openrouter"`, `DEFAULT_MODEL_BY_PROVIDER`, `DEFAULT_CODEX_CONFIG` carries `model_provider`/`model_providers.openrouter` and the open default model                                                                                   |
| CLI       | `sdk/typescript/src/cli.ts`                                     | `--provider` optional, default resolved after overrides (explicit `--codex model_provider`/profile wins); `--model` falls back to the provider's default model; `validate`/`patch` gain `--provider` and forward a registry provider to `codex exec`; help text |
| Pricing   | `sdk/typescript/src/cost.ts`                                    | fallback to generated `src/openrouter-pricing.ts`                                                                                                                                                                                                               |
| Contract  | `sdk/typescript/src/open-models.ts` + 2 gated hunks in `api.ts` | guidance prologue, unseal, validate→repair loop                                                                                                                                                                                                                 |
| Generator | `sdk/typescript/scripts/generate-pricing.mjs`                   | regenerate rows from OpenRouter                                                                                                                                                                                                                                 |
| Tests     | `tests-ts/config.test.ts`, `cli.test.ts`, `cost.test.ts`        | defaults, provider switch, pricing                                                                                                                                                                                                                              |
| Docs      | `README.md`, `sdk/typescript/README.md`, `docs/UPSTREAM.md`     | fork usage, update procedure                                                                                                                                                                                                                                    |

## Out of scope

Chat-completions shim, direct vendor providers, package rename/publishing,
prompt overlays, live pricing fetch at scan time.

## Spike results (2026-08-15, tiny Express target with 3 planted bugs)

| Model (OpenRouter)                              | Outcome                                  | Time   | Cost (list) | Notes                                                           |
| ----------------------------------------------- | ---------------------------------------- | ------ | ----------- | --------------------------------------------------------------- |
| `z-ai/glm-5.2`, run 1 (upstream code)           | found all 3 + 3 lows; **failed to seal** | 11 min | ~$0.30      | wrote `scan.artifacts`, `codeEvidence` as string                |
| `z-ai/glm-5.2`, run 2 (fork)                    | found all 3 + 3 lows; **sealed**         | 24 min | $1.24       | seal fields stripped; no repair turn needed                     |
| `deepseek/deepseek-v4-pro-0813` (upstream code) | found exactly the 3; **sealed**          | 38 min | ~$0.55      | never emitted progress lines; read finalizer source for ~25 min |
