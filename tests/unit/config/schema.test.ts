import { describe, expect, it } from "vitest";

import {
  EvalConfigSchema,
  EvaluationConfigSchema,
  GenerationConfigSchema,
  ScopeConfigSchema,
} from "../../../src/config/schema.js";

describe("ScopeConfigSchema", () => {
  it("applies default values", () => {
    const result = ScopeConfigSchema.parse({});

    expect(result.skills).toBe(true);
    expect(result.agents).toBe(true);
    expect(result.commands).toBe(true);
    expect(result.hooks).toBe(false);
    expect(result.mcp_servers).toBe(false);
  });

  it("allows overriding defaults", () => {
    const result = ScopeConfigSchema.parse({
      skills: false,
      hooks: true,
    });

    expect(result.skills).toBe(false);
    expect(result.hooks).toBe(true);
  });
});

describe("GenerationConfigSchema", () => {
  it("applies default values", () => {
    const result = GenerationConfigSchema.parse({});

    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.scenarios_per_component).toBe(5);
    expect(result.diversity).toBe(0.7);
    expect(result.reasoning_effort).toBe("medium");
    expect(result.temperature).toBe(0.3);
  });

  it("validates scenarios_per_component range", () => {
    expect(() =>
      GenerationConfigSchema.parse({ scenarios_per_component: 0 }),
    ).toThrow();
    expect(() =>
      GenerationConfigSchema.parse({ scenarios_per_component: 25 }),
    ).toThrow();

    const valid = GenerationConfigSchema.parse({ scenarios_per_component: 10 });
    expect(valid.scenarios_per_component).toBe(10);
  });

  it("validates diversity range", () => {
    expect(() => GenerationConfigSchema.parse({ diversity: -0.1 })).toThrow();
    expect(() => GenerationConfigSchema.parse({ diversity: 1.5 })).toThrow();

    const valid = GenerationConfigSchema.parse({ diversity: 0.5 });
    expect(valid.diversity).toBe(0.5);
  });

  it("validates reasoning_effort enum", () => {
    expect(() =>
      GenerationConfigSchema.parse({ reasoning_effort: "invalid" }),
    ).toThrow();

    const valid = GenerationConfigSchema.parse({ reasoning_effort: "high" });
    expect(valid.reasoning_effort).toBe("high");
  });

  it("validates temperature range", () => {
    expect(() => GenerationConfigSchema.parse({ temperature: -0.1 })).toThrow();
    expect(() => GenerationConfigSchema.parse({ temperature: 1.5 })).toThrow();

    const valid = GenerationConfigSchema.parse({ temperature: 0.0 });
    expect(valid.temperature).toBe(0.0);

    const validMax = GenerationConfigSchema.parse({ temperature: 1.0 });
    expect(validMax.temperature).toBe(1.0);
  });
});

describe("EvaluationConfigSchema", () => {
  it("applies default values", () => {
    const result = EvaluationConfigSchema.parse({});

    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.max_tokens).toBe(4000);
    expect(result.detection_mode).toBe("programmatic_first");
    expect(result.reasoning_effort).toBe("low");
    expect(result.temperature).toBe(0.1);
  });

  it("validates temperature range", () => {
    expect(() => EvaluationConfigSchema.parse({ temperature: -0.1 })).toThrow();
    expect(() => EvaluationConfigSchema.parse({ temperature: 1.5 })).toThrow();

    const valid = EvaluationConfigSchema.parse({ temperature: 0.0 });
    expect(valid.temperature).toBe(0.0);

    const validMax = EvaluationConfigSchema.parse({ temperature: 1.0 });
    expect(validMax.temperature).toBe(1.0);
  });
});

describe("EvalConfigSchema", () => {
  it("validates complete configuration", () => {
    const config = {
      plugin: { path: "./my-plugin" },
    };

    const result = EvalConfigSchema.parse(config);

    expect(result.plugin.path).toBe("./my-plugin");
    expect(result.scope.skills).toBe(true);
    expect(result.generation.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.dry_run).toBe(false);
  });

  it("rejects missing plugin path", () => {
    expect(() => EvalConfigSchema.parse({})).toThrow();
    expect(() => EvalConfigSchema.parse({ plugin: {} })).toThrow();
  });

  it("validates detection_mode enum", () => {
    const config = {
      plugin: { path: "./my-plugin" },
      evaluation: { detection_mode: "invalid" },
    };

    expect(() => EvalConfigSchema.parse(config)).toThrow();
  });

  it("accepts valid detection_mode", () => {
    const config = {
      plugin: { path: "./my-plugin" },
      evaluation: { detection_mode: "llm_only" },
    };

    const result = EvalConfigSchema.parse(config);
    expect(result.evaluation.detection_mode).toBe("llm_only");
  });
});
