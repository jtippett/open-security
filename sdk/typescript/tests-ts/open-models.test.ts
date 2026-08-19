import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatUsageDebugLine,
  repairDraftContract,
  unsealDraftManifest,
  usageDebugEnabled,
  withOpenModelsGuidance,
} from "../src/open-models.js";

// open-models fork: draft-contract repair for SDK-owned scans.
const python = Bun.which("python3") ?? Bun.which("python") ?? Bun.which("py");
const roots: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeDraft(
  scanDir: string,
  scan: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(scanDir, "scan-manifest.json"),
    JSON.stringify(
      { documentType: "codex-security.scan-manifest", scan },
      null,
      2,
    ),
  );
  await writeFile(
    join(scanDir, "findings.json"),
    JSON.stringify({ findings: [] }),
  );
  await writeFile(join(scanDir, "coverage.json"), JSON.stringify({}));
}

// A stand-in finalizer: rejects while findings.json contains "BROKEN".
const FAKE_FINALIZER = `import json, sys
from pathlib import Path
args = sys.argv[1:]
scan_dir = Path(args[args.index("--scan-dir") + 1])
Path(scan_dir, "finalized.marker").write_text("sealed")
if "BROKEN" in Path(scan_dir, "findings.json").read_text():
    sys.stderr.write("usage: finalize_scan_contract.py --scan-dir SCAN_DIR\\n")
    sys.stderr.write("finalize_scan_contract.py: error: findings.findings[0].codeEvidence: expected an array\\n")
    sys.exit(2)
`;

async function fakePluginRoot(): Promise<string> {
  const root = await scratch("codex-security-plugin-");
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "scripts", "finalize_scan_contract.py"),
    FAKE_FINALIZER,
  );
  return root;
}

describe("unsealDraftManifest", () => {
  test("removes model-authored seal fields and keeps the rest", async () => {
    const dir = await scratch("codex-security-draft-");
    await writeDraft(dir, {
      id: "scan",
      completedAt: "2026-08-15T00:00:00Z",
      sealedAt: "2026-08-15T00:00:00Z",
      artifacts: [
        { path: "findings.json", sha256: "x", mediaType: "application/json" },
      ],
      coverageRef: "coverage.json",
    });
    const path = join(dir, "scan-manifest.json");
    expect(await unsealDraftManifest(path)).toEqual({
      changed: true,
      removed: ["sealedAt", "artifacts"],
    });
    const scan = JSON.parse(await readFile(path, "utf8")).scan;
    expect(scan).toEqual({
      id: "scan",
      completedAt: "2026-08-15T00:00:00Z",
      coverageRef: "coverage.json",
    });
    expect(await unsealDraftManifest(path)).toEqual({
      changed: false,
      removed: [],
    });
  });

  test("leaves missing, unparsable, and unsealed manifests alone", async () => {
    const dir = await scratch("codex-security-draft-");
    const path = join(dir, "scan-manifest.json");
    expect(await unsealDraftManifest(path)).toEqual({
      changed: false,
      removed: [],
    });
    await writeFile(path, "{not json");
    expect(await unsealDraftManifest(path)).toEqual({
      changed: false,
      removed: [],
    });
    expect(await readFile(path, "utf8")).toBe("{not json");
    await writeDraft(dir, { id: "scan", completedAt: "2026-08-15T00:00:00Z" });
    expect(await unsealDraftManifest(path)).toEqual({
      changed: false,
      removed: [],
    });
  });
});

describe("repairDraftContract", () => {
  test.skipIf(python === null)(
    "asks the thread to repair until the draft validates",
    async () => {
      const dir = await scratch("codex-security-draft-");
      await writeDraft(dir, { id: "scan", artifacts: [] });
      await writeFile(
        join(dir, "findings.json"),
        JSON.stringify({ findings: ["BROKEN"] }),
      );
      const warnings: string[] = [];
      const prompts: string[] = [];
      await repairDraftContract({
        scanDir: dir,
        sourceRoot: dir,
        python: python!,
        pluginRoot: await fakePluginRoot(),
        maxAttempts: 2,
        runTurn: async (prompt) => {
          prompts.push(prompt);
          await writeFile(
            join(dir, "findings.json"),
            JSON.stringify({ findings: [] }),
          );
        },
        warn: (message) => warnings.push(message),
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(
        "findings.findings[0].codeEvidence: expected an array",
      );
      expect(prompts[0]).toContain(
        "do not add scan.sealedAt or scan.artifacts",
      );
      expect(warnings).toEqual([
        "Removed model-authored artifacts from the draft scan manifest before sealing.",
        "Scan output failed contract validation (findings.findings[0].codeEvidence: expected an array); asking the model to repair it (attempt 1 of 2).",
      ]);
      // Validation ran on a private copy: the real draft is untouched by the finalizer.
      expect(await Bun.file(join(dir, "finalized.marker")).exists()).toBe(
        false,
      );
    },
  );

  test.skipIf(python === null)(
    "stops after the configured attempts and reports the last error",
    async () => {
      const dir = await scratch("codex-security-draft-");
      await writeDraft(dir, { id: "scan" });
      await writeFile(
        join(dir, "findings.json"),
        JSON.stringify({ findings: ["BROKEN"] }),
      );
      const warnings: string[] = [];
      let turns = 0;
      await repairDraftContract({
        scanDir: dir,
        sourceRoot: dir,
        python: python!,
        pluginRoot: await fakePluginRoot(),
        maxAttempts: 2,
        runTurn: async () => {
          turns += 1;
        },
        warn: (message) => warnings.push(message),
      });
      expect(turns).toBe(2);
      expect(warnings.at(-1)).toBe(
        "Scan output still fails contract validation after 2 repair attempts: findings.findings[0].codeEvidence: expected an array",
      );
    },
  );

  test("skips repair when the validator cannot run", async () => {
    const dir = await scratch("codex-security-draft-");
    await writeDraft(dir, { id: "scan" });
    let turns = 0;
    const warnings: string[] = [];
    await repairDraftContract({
      scanDir: dir,
      sourceRoot: dir,
      python: join(dir, "missing-python"),
      pluginRoot: dir,
      runTurn: async () => {
        turns += 1;
      },
      warn: (message) => warnings.push(message),
    });
    expect(turns).toBe(0);
    expect(warnings).toEqual([]);
  });

  test.skipIf(python === null)(
    "reports a failed repair turn without throwing",
    async () => {
      const dir = await scratch("codex-security-draft-");
      await writeDraft(dir, { id: "scan" });
      await writeFile(
        join(dir, "findings.json"),
        JSON.stringify({ findings: ["BROKEN"] }),
      );
      const warnings: string[] = [];
      await repairDraftContract({
        scanDir: dir,
        sourceRoot: dir,
        python: python!,
        pluginRoot: await fakePluginRoot(),
        runTurn: async () => {
          throw new Error("turn exploded");
        },
        warn: (message) => warnings.push(message),
      });
      expect(warnings.at(-1)).toBe(
        "Could not run the contract repair turn: turn exploded",
      );
    },
  );
});

describe("withOpenModelsGuidance", () => {
  test("appends contract guidance after any user prompt", () => {
    const guidance = withOpenModelsGuidance(undefined);
    expect(guidance).toContain("omit both: the SDK computes and seals them");
    expect(guidance).toContain("do not run finalize_scan_contract.py");
    expect(guidance).toContain("CODEX_SECURITY_SCAN_DIR");
    const combined = withOpenModelsGuidance("Focus on auth.\n");
    expect(combined.startsWith("Focus on auth.\n\n")).toBe(true);
    expect(combined.endsWith(guidance)).toBe(true);
    expect(withOpenModelsGuidance("   ")).toBe(guidance);
  });
});

describe("usage debugging", () => {
  test("formats a usage line with cache percentage and cost", () => {
    const line = formatUsageDebugLine(
      {
        input_tokens: 20_000,
        cached_input_tokens: 15_000,
        cache_write_input_tokens: 0,
        output_tokens: 4_000,
        reasoning_output_tokens: 1_500,
        total_tokens: 24_000,
      },
      0.1234,
    );
    expect(line).toBe(
      "open-security: usage input=20000 cached=15000 (75% of input) " +
        "cache_writes=0 output=4000 reasoning=1500 total=24000 " +
        "est_cost=$0.1234",
    );
  });

  test("handles zero input and missing cost", () => {
    const line = formatUsageDebugLine(
      {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      },
      null,
    );
    expect(line).toBe(
      "open-security: usage input=0 cached=0 (0% of input) " +
        "cache_writes=0 output=0 reasoning=0 total=0",
    );
  });

  test("is enabled by CODEX_SECURITY_DEBUG_USAGE", () => {
    expect(usageDebugEnabled({})).toBe(false);
    expect(usageDebugEnabled({ CODEX_SECURITY_DEBUG_USAGE: "0" })).toBe(false);
    expect(usageDebugEnabled({ CODEX_SECURITY_DEBUG_USAGE: "1" })).toBe(true);
    expect(usageDebugEnabled({ CODEX_SECURITY_DEBUG_USAGE: "true" })).toBe(
      true,
    );
  });
});
