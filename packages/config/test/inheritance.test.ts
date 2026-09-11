import { describe, expect, it } from "vitest";

import { mergeConfiguration, parseConfigurationDocument } from "../src/index";

describe("mergeConfiguration", () => {
  it("recursively merges objects without mutating either document", () => {
    const parent = {
      mode: "enforce",
      risk: { thresholds: { low: 20, high: 70 }, paths: [] },
    };
    const child = { risk: { thresholds: { high: 80 } } };

    expect(mergeConfiguration(parent, child)).toEqual({
      mode: "enforce",
      risk: { thresholds: { low: 20, high: 80 }, paths: [] },
    });
    expect(parent).toEqual({
      mode: "enforce",
      risk: { thresholds: { low: 20, high: 70 }, paths: [] },
    });
    expect(child).toEqual({ risk: { thresholds: { high: 80 } } });
  });

  it("merges keyed arrays repository-first and retains non-colliding organization entries", () => {
    const parent = {
      risk: {
        paths: [
          { pattern: "src/auth/**", weight: 20, tag: "parent-auth" },
          { pattern: "src/db/**", weight: 30, tag: "database" },
        ],
        suppressors: [
          { if_all_match: ["*.md", "docs/**"], ceiling: 20 },
          { if_all_match: ["examples/**"], ceiling: 30 },
        ],
      },
      ownership: {
        rules: [
          { paths: ["src/api/**", "src/auth/**"], reviewers: ["@parent"] },
          { paths: ["src/db/**"], reviewers: ["@database"] },
        ],
      },
    };
    const child = {
      risk: {
        paths: [{ pattern: "src/auth/**", weight: 50, tag: "repository-auth" }],
        suppressors: [{ if_all_match: [" DOCS/** ", "*.MD"], ceiling: 10 }],
      },
      ownership: {
        rules: [{ paths: [" SRC/AUTH/** ", "src/api/**"], reviewers: ["@child"] }],
      },
    };

    expect(mergeConfiguration(parent, child)).toEqual({
      risk: {
        paths: [
          { pattern: "src/auth/**", weight: 50, tag: "repository-auth" },
          { pattern: "src/db/**", weight: 30, tag: "database" },
        ],
        suppressors: [
          { if_all_match: [" DOCS/** ", "*.MD"], ceiling: 10 },
          { if_all_match: ["examples/**"], ceiling: 30 },
        ],
      },
      ownership: {
        rules: [
          { paths: [" SRC/AUTH/** ", "src/api/**"], reviewers: ["@child"] },
          { paths: ["src/db/**"], reviewers: ["@database"] },
        ],
      },
    });
  });

  it("normalizes scalar-array keys while preserving repository values and order", () => {
    expect(mergeConfiguration(
      { ownership: { fallback_reviewers: ["@Parent", " @shared "] } },
      { ownership: { fallback_reviewers: ["@child", "@SHARED"] } },
    )).toEqual({
      ownership: { fallback_reviewers: ["@child", "@SHARED", "@Parent"] },
    });
  });

  it("deduplicates normalized set members when matching keyed-array entries", () => {
    expect(mergeConfiguration(
      { risk: { suppressors: [{ if_all_match: ["docs/**"], ceiling: 20 }] } },
      { risk: { suppressors: [{ if_all_match: ["DOCS/**", " docs/** "], ceiling: 10 }] } },
    )).toEqual({
      risk: { suppressors: [{ if_all_match: ["DOCS/**", " docs/** "], ceiling: 10 }] },
    });
  });
});

describe("parseConfigurationDocument", () => {
  it.each([
    {
      name: "risk path patterns",
      source: `risk:\n  paths:\n    - { pattern: "src/auth/**", weight: 20, tag: first }\n    - { pattern: " SRC/AUTH/** ", weight: 30, tag: second }`,
      path: "$.risk.paths[1].pattern",
    },
    {
      name: "risk suppressor match sets",
      source: `risk:\n  suppressors:\n    - { if_all_match: ["docs/**", "*.md"], ceiling: 20 }\n    - { if_all_match: [" *.MD ", "DOCS/**"], ceiling: 30 }`,
      path: "$.risk.suppressors[1].if_all_match",
    },
    {
      name: "ownership path sets",
      source: `ownership:\n  rules:\n    - { paths: ["src/api/**", "src/auth/**"], reviewers: ["@first"] }\n    - { paths: [" SRC/AUTH/** ", "SRC/API/**"], reviewers: ["@second"] }`,
      path: "$.ownership.rules[1].paths",
    },
  ])("rejects duplicate $name", ({ source, path }) => {
    const result = parseConfigurationDocument(source, { partial: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected duplicate diagnostics");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path }));
  });

  it("rejects duplicate suppressor keys after normalized set members are deduplicated", () => {
    const result = parseConfigurationDocument(`risk:\n  suppressors:\n    - { if_all_match: ["docs/**"], ceiling: 20 }\n    - { if_all_match: ["DOCS/**", " docs/** "], ceiling: 30 }`, { partial: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected duplicate diagnostics");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      path: "$.risk.suppressors[1].if_all_match",
    }));
  });

  it("rejects normalized duplicate values in scalar arrays", () => {
    const result = parseConfigurationDocument(
      `ownership:\n  fallback_reviewers: ["@Alice", "@ALICE"]`,
      { partial: true },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected duplicate diagnostics");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      path: "$.ownership.fallback_reviewers[1]",
    }));
  });
});
