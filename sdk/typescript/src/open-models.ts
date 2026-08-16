// open-models fork: helpers that keep SDK-owned scans robust across models.
import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface UnsealDraftManifestResult {
  changed: boolean;
  removed: string[];
}

/**
 * The plugin schema lists `scan.sealedAt` and `scan.artifacts` as required,
 * while an SDK-owned scan must leave both out so the finalizer can compute
 * and seal them. Models that follow the schema literally write them anyway,
 * and the finalizer then rejects the manifest as an inconsistent seal.
 * Remove any model-authored seal fields from the draft before completion.
 * A missing or unparsable manifest is left for the finalizer to report.
 */
export async function unsealDraftManifest(
  manifestPath: string,
): Promise<UnsealDraftManifestResult> {
  const unchanged = { changed: false, removed: [] };
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return unchanged;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return unchanged;
  }
  if (!isRecord(document) || !isRecord(document["scan"])) return unchanged;
  const scan = document["scan"];
  const removed = ["sealedAt", "artifacts"].filter((key) =>
    Object.hasOwn(scan, key),
  );
  if (removed.length === 0) return unchanged;
  for (const key of removed) delete scan[key];
  await writeFile(
    manifestPath,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
  return { changed: true, removed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DraftContractRepairOptions {
  scanDir: string;
  sourceRoot: string;
  python: string;
  pluginRoot: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxAttempts?: number;
  runTurn: (prompt: string) => Promise<void>;
  warn: (message: string) => void;
}

/**
 * Validate the model-authored draft with the plugin's own finalizer (run
 * against a private temporary copy so nothing is sealed or written in place)
 * and, when it reports a contract error, ask the same thread to repair the
 * canonical files. Stops after `maxAttempts` repairs or as soon as the draft
 * validates. Never throws for validator failures unrelated to the contract;
 * completion reports those.
 */
export async function repairDraftContract(
  options: DraftContractRepairOptions,
): Promise<void> {
  const attempts = options.maxAttempts ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    const unsealed = await unsealDraftManifest(
      join(options.scanDir, "scan-manifest.json"),
    );
    if (unsealed.changed) {
      options.warn(
        `Removed model-authored ${unsealed.removed.join(" and ")} from the draft scan manifest before sealing.`,
      );
    }
    const error = await draftContractError(options);
    if (error === null) return;
    if (attempt >= attempts || options.signal?.aborted === true) {
      options.warn(
        `Scan output still fails contract validation after ${attempt} repair ${attempt === 1 ? "attempt" : "attempts"}: ${error}`,
      );
      return;
    }
    options.warn(
      `Scan output failed contract validation (${error}); asking the model to repair it (attempt ${attempt + 1} of ${attempts}).`,
    );
    try {
      await options.runTurn(draftRepairPrompt(options, error));
    } catch (turnError) {
      options.warn(
        `Could not run the contract repair turn: ${turnError instanceof Error ? turnError.message : String(turnError)}`,
      );
      return;
    }
  }
}

function draftRepairPrompt(
  options: DraftContractRepairOptions,
  error: string,
): string {
  return [
    `The scan output in ${options.scanDir} failed Codex Security contract validation:`,
    "",
    error,
    "",
    `Fix the canonical files scan-manifest.json, findings.json, and coverage.json in that directory in place so they validate against the JSON Schemas in ${join(options.pluginRoot, "schemas")}.`,
    "This is an SDK-owned scan: do not add scan.sealedAt or scan.artifacts, do not write report.md, do not run the finalizer or completion tools, and do not start another scan.",
    "Keep every finding, location, and piece of evidence; correct only structure and field types. Optional fields must match the schema exactly or be omitted.",
    "Reply with one line summarizing what you changed.",
  ].join("\n");
}

async function draftContractError(
  options: DraftContractRepairOptions,
): Promise<string | null> {
  // The finalizer requires a canonical, non-symlink scan directory.
  const staging = await realpath(
    await mkdtemp(join(tmpdir(), "codex-security-draft-")),
  );
  try {
    await cp(options.scanDir, staging, { recursive: true });
    const stderr = await new Promise<string | null>((resolve) => {
      execFile(
        options.python,
        [
          "-I",
          join(options.pluginRoot, "scripts", "finalize_scan_contract.py"),
          "--scan-dir",
          staging,
          "--source-root",
          options.sourceRoot,
        ],
        {
          env: options.environment ?? process.env,
          signal: options.signal,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        },
        (error, _stdout, stderrText) => {
          if (error === null) return resolve(null);
          if (typeof stderrText !== "string" || stderrText.length === 0) {
            // The validator itself failed to run; leave that to completion.
            return resolve(null);
          }
          resolve(stderrText);
        },
      );
    });
    if (stderr === null) return null;
    const match = /finalize_scan_contract\.py: error: (.*)$/mu.exec(stderr);
    if (match === null) return null;
    return match[1]!.trim();
  } catch {
    return null;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Extra scan instructions for models that were not trained on the Codex
 * Security scan contract. Appended to any user-supplied scan prompt when the
 * scan runs through an external provider. Environment references use the
 * same shell syntax as the base prompt.
 */
export function withOpenModelsGuidance(scanPrompt: string | undefined): string {
  const env = (name: string, suffix = ""): string =>
    `"${process.platform === "win32" ? "$env:" : "$"}${name}${suffix}"`;
  const guidance = [
    "Additional contract guidance for this scan:",
    `- This is an SDK-owned scan. Write unsealed canonical scan-manifest.json, findings.json, and coverage.json into ${env("CODEX_SECURITY_SCAN_DIR")}. Although the schemas mark scan.sealedAt and scan.artifacts as required, omit both: the SDK computes and seals them. Do not write report.md, do not run finalize_scan_contract.py or any completion tool on the scan directory, and do not start another scan.`,
    `- Every field you write must match the JSON Schemas under ${env("CODEX_SECURITY_PLUGIN_ROOT", "/schemas")} exactly, including optional fields such as codeEvidence, remediation, attackPath, and provenance: check each field's type (array versus object versus string), required sub-fields, enums, and patterns. Omit any optional field you cannot express in the exact schema shape rather than approximating it.`,
    "- Keep the scan directory limited to the canonical files and documented evidence artifacts; do not leave helper scripts or scratch files there.",
  ].join("\n");
  const user = scanPrompt?.trim();
  return user ? `${user}\n\n${guidance}` : guidance;
}
