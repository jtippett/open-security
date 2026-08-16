# Tracking upstream

This fork follows [openai/codex-security](https://github.com/openai/codex-security).
The goal is a small, additive diff so that pulling upstream stays a routine
merge rather than a project.

## Remotes and branches

```bash
git remote add upstream https://github.com/openai/codex-security.git   # once
git fetch upstream --tags
```

- `main` — the fork's default branch, released from here.
- `upstream/main` — never modified locally.

## Fork-owned files (never conflict; upstream does not have them)

| Path                                                     | Purpose                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `docs/UPSTREAM.md`                                       | this document                                                  |
| `docs/plans/*`                                           | design notes                                                   |
| `sdk/typescript/src/open-models.ts`                      | contract guidance prologue, draft unseal, validate→repair loop |
| `sdk/typescript/tests-ts/open-models.test.ts`            | tests for the above                                            |
| `sdk/typescript/src/openrouter-pricing.ts`               | generated OpenRouter price catalog                             |
| `sdk/typescript/scripts/generate-openrouter-pricing.mjs` | its generator                                                  |
| `sdk/typescript/tests-ts/open-models-defaults.test.ts`   | fork default behaviour                                         |
| `sdk/typescript/tests-ts/openrouter-pricing.test.ts`     | pricing catalog                                                |

## Upstream files carrying fork hunks (may conflict)

Every fork hunk in an upstream file is marked with a comment containing
`open-models fork` so it can be found with
`git grep -n "open-models fork"`.

| Path                                                                                                        | Fork hunk                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk/typescript/src/config.ts`                                                                              | `DEFAULT_MODEL_PROVIDER`, `DEFAULT_MODEL_BY_PROVIDER`, `defaultModelForProvider`, `applyDefaultModelProvider` block. `DEFAULT_CODEX_CONFIG` is deliberately identical to upstream.                                                                                                                                                                                        |
| `sdk/typescript/src/cli.ts`                                                                                 | imports; `PROVIDER_OPTION` is optional with the fork default in its description; `SKILL_PROVIDER_OPTION` and `--provider` on `validate`/`patch`; `DEFAULT_SCAN_MODEL`; `--model` help text; the tail of `parseCodexOverrides` (default-model fallback and `applyDefaultModelProvider` call); `runSkill` forwards a registry provider to `codex exec` (`tomlInlineTable`). |
| `sdk/typescript/src/cost.ts`                                                                                | one import and the `?? OPENROUTER_MODEL_PRICING_NANODOLLARS[...]` fallback in `estimateScanCost`.                                                                                                                                                                                                                                                                         |
| `sdk/typescript/src/api.ts`                                                                                 | one import; `withOpenModelsGuidance(options.scanPrompt)` where `scanPrompt(...)` is built; the `repairDraftContract(...)` call immediately before `complete-scan`. Both are gated on `externalProvider !== null`, so OpenAI scans behave exactly as upstream.                                                                                                             |
| `sdk/typescript/package.json`                                                                               | `generate:pricing` script; `name` is `not-codex-security` (the `bin` stays `codex-security`).                                                                                                                                                                                                                                                                             |
| `sdk/typescript/src/index.ts`                                                                               | exports the fork's provider helpers (`applyDefaultModelProvider` and friends).                                                                                                                                                                                                                                                                                            |
| `sdk/typescript/src/version.ts`                                                                             | `PACKAGE_NAME` is the fork name (drives update notices).                                                                                                                                                                                                                                                                                                                  |
| `sdk/typescript/scripts/check-package.mjs`, `scripts/release-automation.mjs`                                | package-name checks accept `not-codex-security` (release automation accepts both names so its upstream tests keep passing).                                                                                                                                                                                                                                               |
| `sdk/typescript/tests-ts/update-notice.test.ts`                                                             | expected package name and registry URLs use the fork name.                                                                                                                                                                                                                                                                                                                |
| `sdk/typescript/tests-ts/cli.test.ts`, `tests-ts/cli-authentication.test.ts`, `tests-ts/cli-skills.test.ts` | tests that assert OpenAI-specific behaviour pass `--provider openai`; help-text strings; the `--provider openrouter` without `--model` expectation; `validate --help` now lists `--provider`.                                                                                                                                                                             |
| `README.md`, `sdk/typescript/README.md`                                                                     | root README restructured as a fork getting-started guide; package README renamed, from-source install, SDK OpenRouter example. Expect conflicts; keep upstream's new content and re-apply the fork framing.                                                                                                                                                                |

Keep it that way: when adding fork behaviour, prefer a new file, and when an
upstream file must change, keep the hunk small, self-contained, and marked.

## Update procedure

1. Fetch and inspect what changed upstream, especially in the files above:

   ```bash
   git fetch upstream --tags
   git log --oneline main..upstream/main
   git diff main...upstream/main --stat -- sdk/typescript/src/config.ts sdk/typescript/src/cli.ts sdk/typescript/src/cost.ts sdk/typescript/package.json
   ```

2. Merge (not rebase, so published history stays stable):

   ```bash
   git checkout -b sync/upstream-$(git rev-parse --short upstream/main) main
   git merge upstream/main
   ```

   Resolve conflicts by keeping upstream's version of the surrounding code and
   re-applying the marked fork hunk. If upstream changed
   `EXTERNAL_CODEX_PROVIDERS`, `parseCodexOverrides`, `scanAuthentication`, or
   the provider handling in `api.ts`, re-read the fork block in `config.ts`
   and confirm the assumptions in its comments still hold.

3. Re-check the things that drift silently:

   - Codex runtime version (`@openai/codex` / `@openai/codex-sdk` in
     `package.json`): confirm OpenRouter's Responses endpoint still works with
     the pinned Codex, e.g. `codex-security scan <small-repo> --dry-run` and one
     real scan.
   - Upstream's `MODEL_PRICING_NANODOLLARS` in `cost.ts` stays authoritative
     for OpenAI models; regenerate the OpenRouter catalog:
     `pnpm generate:pricing`.
   - The default model in `DEFAULT_MODEL_BY_PROVIDER` is still available on
     OpenRouter (`curl -s https://openrouter.ai/api/v1/models | grep <id>`).
   - `_bundled_plugin` is an upstream build artifact; never edit it. The fork
     depends on two of its interfaces: the SDK-owned scan rules in
     `skills/security-scan/SKILL.md` (write unsealed canonical files, omit
     `scan.sealedAt`/`scan.artifacts`) and
     `scripts/finalize_scan_contract.py --scan-dir --source-root` reporting
     contract errors as `finalize_scan_contract.py: error: <message>` on
     stderr. If either changes, update `src/open-models.ts`
     (`withOpenModelsGuidance`, `unsealDraftManifest`, `draftContractError`).

4. Verify from `sdk/typescript`:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run types
   pnpm run format
   pnpm run test
   git grep -n "open-models fork"   # every hunk still present
   ```

5. Open a PR from the `sync/*` branch into `main`, merge, tag.

## Releasing

Upstream publishes `@openai/codex-security`; this fork's package is named
`not-codex-security` (the installed command is still `codex-security`). The
fork is not published to npm — the READMEs document a from-source install. The
`.github/workflows` release pipeline still targets the upstream name and repo
(`github.repository == 'openai/codex-security'` guards make it a no-op on the
fork); `repository`/`bugs` URLs in `sdk/typescript/package.json` still point
at upstream. If the fork is ever published, update those URLs and revisit
`scripts/release-automation.mjs`, which currently accepts both package names.

## Still pending

- Flip `DEFAULT_MODEL_BY_PROVIDER.openrouter` to GLM 5.3 once it is listed on
  OpenRouter (check with
  `curl -s https://openrouter.ai/api/v1/models | grep glm-5.3`), then
  `pnpm generate:pricing` and update the model table in `README.md`.
