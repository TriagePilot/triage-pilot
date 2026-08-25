import { describe, expect, it } from "vitest";

import { parseTriagePilotConfig } from "../src/index";

describe("parseTriagePilotConfig", () => {
  it("parses the PRD example with defaults", () => {
    const result = parseTriagePilotConfig(`
version: 1
mode: enforce
routing:
  high_risk_reviewers: 2
  exclude_target_branches: ["main", "master"]
  exclude_source_branch_patterns: ["dependabot/**"]
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
      reviewers: ["@sasha"]
  fallback_reviewers: ["@sasha"]
`);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected config to parse");
    expect(result.config.version).toBe(1);
    expect(result.config.mode).toBe("enforce");
    expect(result.config.routing.highRiskReviewers).toBe(2);
    expect(result.config.routing.excludeTargetBranches).toEqual(["main", "master"]);
    expect(result.config.routing.excludeSourceBranchPatterns).toEqual(["dependabot/**"]);
    expect(result.config.risk.size).toEqual({ highChangedFiles: 120, highChangedLines: 6000 });
    expect(result.config.risk.thresholds).toEqual({ low: 25, high: 70 });
    expect(result.config.risk.paths[0]).toEqual({ pattern: "src/auth/**", weight: 30, tag: "auth" });
    expect(result.config.risk.suppressors[0]).toEqual({ ifAllMatch: ["docs/**", "*.md", "*.mdx"], ceiling: 25 });
    expect(result.config.risk.aiAuthorship).toEqual({ enabled: true, modifier: 10 });
    expect(result.config.ownership.rules[0]).toEqual({ paths: ["src/auth/**"], reviewers: ["@sasha"] });
    expect(result.config.ownership.fallbackReviewers).toEqual(["@sasha"]);
  });

  it("defaults missing configuration to shadow mode", () => {
    const result = parseTriagePilotConfig("");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected defaults");
    expect(result.config.mode).toBe("shadow");
    expect(result.config.routing.highRiskReviewers).toBe(1);
    expect(result.config.routing.excludeTargetBranches).toEqual([]);
    expect(result.config.routing.excludeSourceBranchPatterns).toEqual([]);
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
      reviewers: ["sasha"]
  fallback_reviewers: []
`);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected config parse to fail");
    expect(result.diagnostics[0]?.message).toContain("reviewer");
  });

  it.each([
    'ownership:\n  rules:\n    - paths: ["src/**"]\n      reviewers: ["@acme/security"]\n',
    'ownership:\n  fallback_reviewers: ["@acme/security"]\n',
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
});
