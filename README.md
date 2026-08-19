# open-security

Security scanning for your code, powered by open-weight models.

This is a fork of [openai/codex-security](https://github.com/openai/codex-security) —
a CLI and TypeScript SDK for finding, validating, and fixing security
vulnerabilities — modified to run open models (GLM, DeepSeek, Kimi, MiniMax,
Qwen, and anything else on [OpenRouter](https://openrouter.ai)) by default.
You need an OpenRouter API key; you do not need an OpenAI account or a ChatGPT
sign-in. Everything upstream supports still works — see
[Using OpenAI and other providers](#using-openai-and-other-providers).

## Getting started

### 1. Prerequisites

- **Node.js** 22.13+, 24.x, or 26.x
- **Python** 3.10 or later (3.10 also needs `tomli`)
- An **OpenRouter API key** with some credit — create one at
  [openrouter.ai/keys](https://openrouter.ai/settings/keys). A standard scan of
  a small repository costs roughly $0.30–$1.50 with the default model.

### 2. Install

```bash
npm install -g open-security
```

Or from this repository (needs pnpm; `corepack enable` turns it on):

```bash
git clone https://github.com/jtippett/open-security.git
cd open-security/sdk/typescript
pnpm install
pnpm run build
npm install -g .
```

Verify the CLI is on your PATH:

```bash
open-security --version
```

(To skip the global install, run the same commands through
`node sdk/typescript/bin/open-security.mjs` instead of `open-security`.)

### 3. Set your OpenRouter API key

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

Put that line in your shell profile or a local secrets file you source; the
CLI reads the environment variable only and never stores the key.

### 4. Run your first scan

From the repository you want to scan:

```bash
open-security scan .
```

That runs a standard scan with `z-ai/glm-5.3` at the default reasoning effort
and prints a findings report when it completes. Expect roughly 10–40 minutes
depending on repository size and model speed — open models are slower than
the upstream OpenAI path, so let it run. Useful variations:

```bash
open-security scan . --model deepseek/deepseek-v4-pro --effort high
open-security scan . --max-cost 2.50        # stop if estimated cost exceeds $2.50
open-security scan . --verbose              # progress diagnostics on stderr
```

## Choosing a model

Any OpenRouter model id works with `--model`. Models that have done well in
our testing:

| Model             | `--model` id               | Notes                                                                         |
| ----------------- | -------------------------- | ----------------------------------------------------------------------------- |
| GLM 5.3 (default) | `z-ai/glm-5.3`             | Best quality in the GLM line.                                                 |
| GLM 5.2           | `z-ai/glm-5.2`             | Good quality, slightly cheaper.                                               |
| DeepSeek V4 Pro   | `deepseek/deepseek-v4-pro` | Followed the scan contract unaided in testing; slower.                        |
| Kimi K3           | `moonshotai/kimi-k3`       |                                                                               |
| MiniMax M3        | `minimax/minimax-m3`       |                                                                               |
| Qwen 3.8 Max      | `qwen/qwen3.8-max`         |                                                                               |

`--effort` accepts `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`;
OpenRouter maps it to each model's reasoning controls. Cost tracking and
`--max-cost` use OpenRouter list prices from a generated catalog
(`pnpm generate:pricing` in `sdk/typescript` refreshes it).

## Using OpenAI and other providers

`--provider openai` restores upstream behaviour, including its default model
`gpt-5.6-sol`, ChatGPT sign-in (`open-security login`), and Trusted Access
for Cyber (some cybersecurity requests and protected findings require approval
via [chatgpt.com/cyber](https://chatgpt.com/cyber)). For CI, set
`OPENAI_API_KEY` or `CODEX_API_KEY` instead of signing in.

```bash
open-security login   # only for --provider openai
open-security scan . --provider openai --model gpt-5.6-terra --effort high

export FIREWORKS_API_KEY="<your-fireworks-api-key>"
open-security scan . --provider fireworks --model accounts/fireworks/models/qwen3-235b-a22b

export AWS_BEARER_TOKEN_BEDROCK="<your-bedrock-api-key>"
export AWS_REGION="us-east-2"
open-security scan . --provider amazon-bedrock --model openai.gpt-5.6-luna
```

Amazon Bedrock also supports standard AWS access keys, profiles, web identity,
container credentials, and the default AWS credential chain. If both a ChatGPT
sign-in and an API key are available, interactive scans ask which credential to
use; select one explicitly with `--auth chatgpt` or `--auth api-key`.

## How this fork differs from upstream

- `scan`, `validate`, and `patch` default to
  `--provider openrouter --model z-ai/glm-5.3`.
- Open models do not always meet the scan output contract on the first pass.
  For external providers the CLI appends contract guidance to the scan prompt,
  validates the draft output with the plugin's own finalizer, and asks the same
  session to repair any reported error (at most twice) before sealing.
- Direct vendor endpoints are not supported: the Codex runtime only speaks the
  OpenAI Responses API (`wire_api = "chat"` was removed in Codex 0.148), and
  OpenRouter normalizes that for every model.
- The package and its installed command are both named `open-security`.
- The fork tracks upstream; see [`docs/UPSTREAM.md`](docs/UPSTREAM.md) for the
  update procedure and the list of fork-owned files.

## Troubleshooting

- **"Scan output directory must not be accessible to other users"** — the
  directories passed as `--output-dir` and `CODEX_SECURITY_STATE_DIR` must be
  private: `chmod 700 <dir>`.
- **Scan seems stuck** — add `--verbose` (or set
  `CODEX_SECURITY_LOG_LEVEL=debug`) for progress on stderr; open models can
  legitimately take 30+ minutes on larger repositories. JSON results stay on
  stdout. Use `open-security scans logs SCAN_ID` to inspect saved session
  events afterwards.
- **Costs higher than expected** — pass `--max-cost <usd>`; the scan stops
  cleanly and keeps completed findings once the estimate exceeds the limit.
- **"contract validation" warnings** — expected with open models; the CLI
  repairs the draft automatically. A scan only fails if the output still does
  not validate after two repair attempts.

Verbose diagnostics may contain sensitive data. Review local logs before
sharing them. Saved failure summaries, bulk-scan receipts, and the interactive
dashboard omit messages that contain recognizable credentials.

## More scan features

Everything below is inherited from upstream and works with any provider.

```bash
open-security scan . --scan-prompt-file scan.md --post-scan-prompt-file follow-up.md
open-security scan . --mode deep --workers 2 --subagents 0 --stop-after-no-new 3 --max-discovery-runs 10 --max-time-hours 1.5
```

Deep-scan discovery stops after 96 hours by default; `--max-time-hours`
accepts any positive number of hours up to 96, and completed findings are
preserved when the limit is reached.

Scan history is stored in the Codex Security workbench state directory. If that
directory cannot be written, set `CODEX_SECURITY_STATE_DIR` to a writable
directory outside the repository.

`findings list [repository]` shows open findings across a repository's scans
and identifies findings not confirmed in its latest scan.

`scans compare BEFORE_SCAN_ID AFTER_SCAN_ID` automatically matches findings by
root cause, reuses saved matches, and identifies new, persisting, reopened,
resolved, or unknown findings.

## TypeScript SDK

The SDK constructor does not apply the fork's CLI default, so opt in to
OpenRouter explicitly:

```ts
import { CodexSecurity, applyDefaultModelProvider } from "open-security";

const codexOverrides = {};
applyDefaultModelProvider(codexOverrides, undefined); // selects OpenRouter + the default model
codexOverrides["model"] = "deepseek/deepseek-v4-pro"; // optional: pick another model

const security = new CodexSecurity({ codexOverrides });
const result = await security.run(".");
console.log(result.reportPath);
await security.close();
```

See the [package README](sdk/typescript/README.md) for the full SDK surface.

## Containerized bulk scans

Use the official image and included Docker Compose configuration for
noninteractive, resumable scans of repositories pinned to immutable Git
revisions. See the [container quick start](sdk/typescript/README.md#containerized-bulk-scans)
for authentication, private result storage, and optional Ubuntu AppArmor
hardening.

Pass `--knowledge-base PATH` to share security documents with every repository;
repeat the option for multiple files or directories.

Use `--scan-prompt-file PATH` to add shared scan instructions, and add a `prompt`
CSV column for repository-specific instructions. Use
`--post-scan-prompt-file PATH` to run a follow-up after each scan, including
incomplete or failed scans.

For complete command help, runtime defaults, native multi-agent worker limits,
environment variables, deep-scan configuration, and SDK options, see the
[package README](sdk/typescript/README.md) and the upstream
[Codex Security documentation](https://learn.chatgpt.com/docs/security/cli).
