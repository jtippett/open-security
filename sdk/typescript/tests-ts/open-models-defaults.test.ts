import { describe, expect, test } from "bun:test";
import { main, parseCodexOverrides } from "../src/cli.js";
import type { CodexSecurityConfig, JsonObject } from "../src/index.js";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_PROVIDER,
  OPENROUTER_CODEX_PROVIDER,
  applyDefaultModelProvider,
  defaultModelForProvider,
} from "../src/config.js";
import { capture, dependencies } from "./cli-fixtures.js";

const OPENROUTER_DEFAULTS = {
  model: "z-ai/glm-5.2",
  model_provider: "openrouter",
  model_providers: { openrouter: OPENROUTER_CODEX_PROVIDER },
};

describe("open-models defaults", () => {
  test("defaults an unconfigured scan to OpenRouter", () => {
    expect(parseCodexOverrides([], undefined, undefined, undefined)).toEqual(
      OPENROUTER_DEFAULTS,
    );
  });

  test("keeps an explicit model while defaulting its provider", () => {
    expect(
      parseCodexOverrides([], "gpt-5.6-terra", undefined, undefined),
    ).toEqual({
      ...OPENROUTER_DEFAULTS,
      model: "gpt-5.6-terra",
    });
  });

  test("keeps the upstream defaults for an explicit OpenAI provider", () => {
    expect(parseCodexOverrides([], undefined, undefined, "openai")).toEqual({});
  });

  test("defaults an explicit OpenRouter provider model", () => {
    expect(parseCodexOverrides([], undefined, undefined, "openrouter")).toEqual(
      OPENROUTER_DEFAULTS,
    );
  });

  test("requires a model for providers without a default", () => {
    expect(() =>
      parseCodexOverrides([], undefined, undefined, "fireworks"),
    ).toThrow("--model is required when using --provider fireworks");
  });

  test("respects an explicit model provider override", () => {
    expect(
      parseCodexOverrides(
        ['model_provider="amazon-bedrock"'],
        undefined,
        undefined,
        undefined,
      ),
    ).toEqual({ model_provider: "amazon-bedrock" });
  });

  test("respects the selected profile model provider", () => {
    expect(
      parseCodexOverrides(
        ['profile="p"', 'profiles.p.model_provider="openai"'],
        undefined,
        undefined,
        undefined,
      ),
    ).toEqual({
      profile: "p",
      profiles: { p: { model_provider: "openai" } },
    });
  });

  test("does not inject a root model when the selected profile has one", () => {
    expect(
      parseCodexOverrides(
        ['profile="p"', 'profiles.p.model="foo"'],
        undefined,
        undefined,
        undefined,
      ),
    ).toEqual({
      profile: "p",
      profiles: { p: { model: "foo" } },
      model_provider: "openrouter",
      model_providers: { openrouter: OPENROUTER_CODEX_PROVIDER },
    });
  });

  test("exports provider model defaults", () => {
    expect(DEFAULT_MODEL_PROVIDER).toBe("openrouter");
    expect(DEFAULT_MODEL_BY_PROVIDER).toEqual({
      openai: "gpt-5.6-sol",
      openrouter: "z-ai/glm-5.2",
    });
    expect(defaultModelForProvider("openai")).toBe("gpt-5.6-sol");
    expect(defaultModelForProvider("openrouter")).toBe("z-ai/glm-5.2");
    expect(defaultModelForProvider("fireworks")).toBeUndefined();
    expect(defaultModelForProvider("amazon-bedrock")).toBeUndefined();
  });

  test("applies the default provider only when none was requested", () => {
    const overrides: JsonObject = { features: { goals: true } };
    applyDefaultModelProvider(overrides, undefined);
    expect(overrides).toEqual({
      features: { goals: true },
      ...OPENROUTER_DEFAULTS,
    });

    const explicitOpenAI: JsonObject = {};
    applyDefaultModelProvider(explicitOpenAI, "openai");
    expect(explicitOpenAI).toEqual({});
  });

  test("maps CLI defaults and preserves explicit OpenAI configuration", async () => {
    for (const [options, expected] of [
      [[], OPENROUTER_DEFAULTS],
      [["--provider", "openai"], {}],
    ] as const) {
      const stdout = capture();
      const stderr = capture();
      let config: CodexSecurityConfig | undefined;

      expect(
        await main(
          ["scan", "repo", "--dry-run", "--json", ...options],
          stdout.stream,
          stderr.stream,
          dependencies({ onConfig: (value) => (config = value) }),
        ),
      ).toBe(0);
      expect(config?.codexOverrides).toEqual(expected);
      expect(JSON.parse(stdout.text())).toMatchObject({ dryRun: true });
      expect(stderr.text()).not.toContain("Running scan");
    }
  });

  test("documents the OpenRouter defaults in scan help", async () => {
    const stdout = capture();
    const stderr = capture();

    expect(
      await main(
        ["scan", "--help"],
        stdout.stream,
        stderr.stream,
        dependencies(),
      ),
    ).toBe(0);
    expect(stdout.text()).toContain("Model to use (default: z-ai/glm-5.2).");
    expect(stdout.text()).toContain(
      "Inference provider for scans (default: openrouter).",
    );
    expect(stderr.text()).toBe("");
  });
});

describe("open-models defaults for validation and patching", () => {
  test("leaves a present but invalid model for validation to reject", () => {
    const overrides = parseCodexOverrides(
      ['model="  "'],
      undefined,
      undefined,
      undefined,
    );
    expect(overrides["model"]).toBe("  ");
    expect(overrides["model_provider"]).toBe("openrouter");
  });

  test("routes validate and patch through the default provider", async () => {
    for (const command of ["validate", "patch"] as const) {
      let invocation: readonly string[] = [];
      expect(
        await main(
          [command, `${command} literal`],
          capture().stream,
          capture().stream,
          dependencies({
            onCodex: (args) => {
              invocation = args;
              return 0;
            },
          }),
        ),
      ).toBe(0);
      expect(invocation).toContain('model="z-ai/glm-5.2"');
      expect(invocation).toContain('model_provider="openrouter"');
      expect(invocation).toContain(
        'model_providers.openrouter={ name = "OpenRouter", base_url = "https://openrouter.ai/api/v1", env_key = "OPENROUTER_API_KEY", wire_api = "responses" }',
      );
    }
  });

  test("keeps validate and patch on OpenAI when asked", async () => {
    let invocation: readonly string[] = [];
    expect(
      await main(
        ["validate", "--provider", "openai", "finding"],
        capture().stream,
        capture().stream,
        dependencies({
          onCodex: (args) => {
            invocation = args;
            return 0;
          },
        }),
      ),
    ).toBe(0);
    expect(invocation).toContain('model="gpt-5.6-sol"');
    expect(invocation.some((arg) => arg.startsWith("model_provider="))).toBe(
      false,
    );
  });

  test("still rejects other provider configuration for validation", async () => {
    let started = false;
    const stderr = capture();
    expect(
      await main(
        ["validate", "finding", "--codex", 'model_provider="amazon-bedrock"'],
        capture().stream,
        stderr.stream,
        dependencies({
          onCodex: () => {
            started = true;
            return 0;
          },
        }),
      ),
    ).toBe(2);
    expect(started).toBe(false);
    expect(stderr.text()).toContain(
      "only support model and model_reasoning_effort",
    );
  });
});
