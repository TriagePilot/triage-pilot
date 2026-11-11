import { describe, expect, it } from "vitest";

import { parseConfigurationDocument, parseTriagePilotConfig } from "../src/index";

describe("parseTriagePilotConfig", () => {
  it("parses the PRD example with defaults", () => {
    const result = parseTriagePilotConfig(`
version: 1
mode: enforce
routing:
  high_risk_reviewers: 2
  exclude_target_branches: ["main", "master"]
  exclude_source_branch_patterns: ["automated-updates/**"]
risk:
  size:
    high_changed_files: 120
    high_changed_lines: 6000
  thresholds:
    low: 25
    high: 70
  paths:
    - pattern: "src/auth/**"
      weight: 30
      tag: auth
  suppressors:
    - if_all_match: ["docs/**", "*.md", "*.mdx"]
      ceiling: 25
  ai_authorship:
    enabled: true
    modifier: 10
ownership:
  rules:
    - paths: ["src/auth/**"]
      reviewers: ["@user-f37a82"]
  fallback_reviewers: ["@user-f37a82"]
`);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected config to parse");
    expect(result.config.version).toBe(1);
    expect(result.config.mode).toBe("enforce");
    expect(result.config.routing.highRiskReviewers).toBe(2);
    expect(result.config.routing.excludeTargetBranches).toEqual(["main", "master"]);
    expect(result.config.routing.excludeSourceBranchPatterns).toEqual(["automated-updates/**"]);
    expect(result.config.routing.includeDraftPullRequests).toBe(false);
    expect(result.config.risk.size).toEqual({ highChangedFiles: 120, highChangedLines: 6000 });
    expect(result.config.risk.thresholds).toEqual({ low: 25, high: 70 });
    expect(result.config.risk.paths[0]).toEqual({ pattern: "src/auth/**", weight: 30, tag: "auth" });
    expect(result.config.risk.suppressors[0]).toEqual({ ifAllMatch: ["docs/**", "*.md", "*.mdx"], ceiling: 25 });
    expect(result.config.risk.aiAuthorship).toEqual({ enabled: true, modifier: 10 });
    expect(result.config.ownership.rules[0]).toEqual({ paths: ["src/auth/**"], reviewers: ["@user-f37a82"] });
    expect(result.config.ownership.fallbackReviewers).toEqual(["@user-f37a82"]);
  });

  it("defaults missing configuration to shadow mode", () => {
    const result = parseTriagePilotConfig("");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected defaults");
    expect(result.config.mode).toBe("shadow");
    expect(result.config.routing.highRiskReviewers).toBe(1);
    expect(result.config.routing.excludeTargetBranches).toEqual([]);
    expect(result.config.routing.excludeSourceBranchPatterns).toEqual([]);
    expect(result.config.routing.includeDraftPullRequests).toBe(false);
    expect(result.config.risk.size).toEqual({ highChangedFiles: 100, highChangedLines: 5000 });
    expect(Object.keys(result.config).sort()).toEqual(["mode", "ownership", "risk", "routing", "version"]);
  });

  it.each([0, 3])("rejects high_risk_reviewers=%s outside the supported one-or-two range", (count) => {
    const result = parseTriagePilotConfig(`
version: 1
routing:
  high_risk_reviewers: ${count}
`);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected config parse to fail");
    expect(result.diagnostics[0]?.path).toBe("$.routing.high_risk_reviewers");
  });

  it.each(["observe", "disabled"])("rejects unsupported mode %s", (mode) => {
    const result = parseTriagePilotConfig(`version: 1\nmode: ${mode}\n`);
    expect(result.ok).toBe(false);
  });

  it("rejects removed SLA configuration", () => {
    const result = parseTriagePilotConfig("version: 1\nsla:\n  human_review_first_touch_hours: 4\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected diagnostics");
    expect(result.diagnostics[0]?.path).toBe("$");
  });

  it("returns diagnostics for invalid reviewer handles", () => {
    const result = parseTriagePilotConfig(`
version: 1
ownership:
  rules:
    - paths: ["src/**"]
      reviewers: ["user-f37a82"]
  fallback_reviewers: []
`);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected config parse to fail");
    expect(result.diagnostics[0]?.message).toContain("reviewer");
  });

  it.each([
    'ownership:\n  rules:\n    - paths: ["src/**"]\n      reviewers: ["@team-a7f19c/security"]\n',
    'ownership:\n  fallback_reviewers: ["@team-a7f19c/security"]\n',
  ])("rejects team reviewer handles", (ownership) => {
    const result = parseTriagePilotConfig(`version: 1\nmode: enforce\n${ownership}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.message).toContain("individual GitHub user handle");
  });

  it("rejects unknown config keys with a useful diagnostic", () => {
    const result = parseTriagePilotConfig(`
version: 1
risk:
  pathz: []
`);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected config parse to fail");
    expect(result.diagnostics[0]?.path).toBe("$.risk");
    expect(result.diagnostics[0]?.message).toContain("pathz");
  });

  it("accepts the maximum supported high-risk threshold", () => {
    const result = parseTriagePilotConfig(`
version: 1
risk:
  thresholds: { low: 25, high: 100 }
`);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected config to parse");
    expect(result.config.risk.thresholds.high).toBe(100);
  });

  it("parses inheritance as a repository document control", () => {
    const result = parseConfigurationDocument("inheritance: true\nrisk:\n  thresholds:\n    high: 80\n", { partial: true });

    expect(result).toEqual({
      ok: true,
      document: { inheritance: true, risk: { thresholds: { high: 80 } } },
      diagnostics: [],
    });
  });

  it("does not expose inheritance to the execution schema", () => {
    const result = parseTriagePilotConfig("inheritance: true\nmode: enforce\n");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected execution parsing to reject document controls");
    expect(result.diagnostics[0]?.path).toBe("$");
  });
});

it("accepts and validates author risk rules", () => {
  const valid = parseTriagePilotConfig('risk:\n  authors:\n    - { authors: ["@Alex", "@sam"], weight: 30, tag: review }');
  expect(valid).toMatchObject({ ok: true, config: { risk: { authors: [{ authors: ["@Alex", "@sam"], weight: 30, tag: "review" }] } } });
  const duplicate = parseTriagePilotConfig('risk:\n  authors:\n    - { authors: ["@Alex", "@alex"], weight: 30, tag: review }');
  expect(duplicate.ok).toBe(false);
});

it.each([
  '{ authors: [], weight: 1, tag: x }',
  '{ authors: ["alex"], weight: 1, tag: x }',
  '{ authors: ["@team/name"], weight: 1, tag: x }',
  '{ authors: ["@alex"], weight: -1, tag: x }',
  '{ authors: ["@alex"], weight: 101, tag: x }',
  '{ authors: ["@alex"], weight: 1, tag: "" }',
  '{ author: "@alex", weight: 1, tag: x }',
])("rejects invalid author rules: %s", (rule) => {
  expect(parseTriagePilotConfig(`risk:\n  authors:\n    - ${rule}`).ok).toBe(false);
});

it("rejects duplicate author sets in direct and document parsing", () => {
  const source = 'risk:\n  authors:\n    - { authors: ["@Alex", "@Sam"], weight: 1, tag: a }\n    - { authors: ["@sam", "@alex"], weight: 2, tag: b }';
  for (const result of [parseTriagePilotConfig(source), parseConfigurationDocument(source, { partial: true })]) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "$.risk.authors[1].authors" }));
  }
});
