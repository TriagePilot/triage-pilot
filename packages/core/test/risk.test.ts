import { describe, expect, it } from "vitest";

import { scorePullRequestRisk } from "../src/risk";
import { parseTriagePilotConfig } from "../../config/src/index";

const baseConfig = {
  size: { highChangedFiles: 100, highChangedLines: 5_000 },
  thresholds: { low: 25, high: 70 },
  paths: [{ pattern: "src/auth/**", weight: 30, tag: "auth" }],
  suppressors: [{ ifAllMatch: ["docs/**", "*.md", "*.mdx"], ceiling: 25 }],
  aiAuthorship: { enabled: true, modifier: 10 },
};

describe("scorePullRequestRisk", () => {
  it("caps docs-only changes at the low threshold", () => {
    const result = scorePullRequestRisk({
      files: [{ path: "docs/setup.md", additions: 12, deletions: 1 }],
      author: "priyaa",
      branchName: "docs/setup",
      commitMessages: ["docs: update setup"],
      config: baseConfig,
    });

    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.tier).toBe("low");
    expect(result.components.map((component) => component.reason)).toContain("docs_or_test_suppressor");
  });

  it("marks auth path plus AI branch as medium risk", () => {
    const result = scorePullRequestRisk({
      files: [{ path: "src/auth/session.ts", additions: 20, deletions: 4 }],
      author: "user-b4e82d",
      branchName: "codex/fix-session",
      commitMessages: ["feat: update session handling"],
      config: baseConfig,
    });

    expect(result.score).toBe(45);
    expect(result.tier).toBe("medium");
    expect(result.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "changed_file_count", score: 5 }),
        expect.objectContaining({ reason: "high_risk_path:auth", score: 30 }),
        expect.objectContaining({ reason: "ai_authorship_signal", score: 10 }),
      ]),
    );
  });

  it("accepts parsed risk config directly", () => {
    const configResult = parseTriagePilotConfig(`
version: 1
risk:
  paths:
    - pattern: "src/auth/**"
      weight: 30
      tag: auth
`);
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) throw new Error("expected config to parse");

    const result = scorePullRequestRisk({
      files: [{ path: "src/auth/policy.ts", additions: 2, deletions: 1 }],
      author: "priyaa",
      branchName: "feature/policy",
      commitMessages: ["feat: update auth policy"],
      config: configResult.config.risk,
    });

    expect(result.score).toBe(35);
    expect(result.tier).toBe("medium");
  });

  it.each([
    { weight: 20, expectedScore: 25, expectedTier: "low" },
    { weight: 21, expectedScore: 26, expectedTier: "medium" },
    { weight: 65, expectedScore: 70, expectedTier: "medium" },
    { weight: 66, expectedScore: 71, expectedTier: "high" },
  ] as const)("routes score $expectedScore as $expectedTier risk", ({ weight, expectedScore, expectedTier }) => {
    const result = scorePullRequestRisk({
      files: [{ path: "src/routing.ts", additions: 1, deletions: 1 }],
      author: "priyaa",
      branchName: "feature/routing",
      commitMessages: ["feat: update routing"],
      config: {
        size: { highChangedFiles: 100, highChangedLines: 5_000 },
        thresholds: { low: 25, high: 70 },
        paths: [{ pattern: "src/routing.ts", weight, tag: "routing" }],
        suppressors: [],
        aiAuthorship: { enabled: false, modifier: 10 },
      },
    });

    expect(result.score).toBe(expectedScore);
    expect(result.tier).toBe(expectedTier);
  });

  it("caps total risk score at 100", () => {
    const result = scorePullRequestRisk({
      files: [
        { path: "src/auth/session.ts", additions: 150, deletions: 50 },
        { path: "src/schema/user.ts", additions: 1, deletions: 0 },
        { path: "pnpm-lock.yaml", additions: 1, deletions: 0 },
      ],
      author: "user-8b4c20",
      branchName: "user-8b4c20/update-session",
      commitMessages: ["feat: update session"],
      config: {
        size: { highChangedFiles: 100, highChangedLines: 5_000 },
        thresholds: { low: 25, high: 70 },
        paths: [{ pattern: "src/auth/**", weight: 80, tag: "auth" }],
        suppressors: [],
        aiAuthorship: { enabled: true, modifier: 20 },
      },
    });

    expect(result.score).toBe(100);
    expect(result.tier).toBe("high");
  });

  it("requires AI co-author markers on the Co-authored-by line", () => {
    const result = scorePullRequestRisk({
      files: [{ path: "src/session.ts", additions: 1, deletions: 1 }],
      author: "priyaa",
      branchName: "feature/session",
      commitMessages: ["feat: update codex docs\n\nCo-authored-by: Priyaa <priyaa@example.com>"],
      config: baseConfig,
    });

    expect(result.components.map((component) => component.reason)).not.toContain("ai_authorship_signal");
  });

  it("excludes test files from generic scoring signals", () => {
    const result = scorePullRequestRisk({
      files: [
        { path: "src/auth/session.ts", additions: 200, deletions: 0 },
        { path: "src/auth/__tests__/session.spec.ts", additions: 2_000, deletions: 0 },
        { path: "src/auth/session.test.ts", additions: 2_000, deletions: 0 },
        { path: "test/smoke.ts", additions: 2_000, deletions: 0 },
        { path: "tests/e2e.ts", additions: 2_000, deletions: 0 },
      ],
      author: "priyaa",
      branchName: "feature/session",
      commitMessages: ["feat: update session"],
      config: {
        thresholds: { low: 15, high: 90 },
        size: { highChangedFiles: 100, highChangedLines: 5_000 },
        paths: [{ pattern: "src/auth/**", weight: 30, tag: "auth" }],
        suppressors: [],
        aiAuthorship: { enabled: false, modifier: 0 },
      },
    });

    expect(result.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "changed_file_count", detail: "1 changed file" }),
        expect.objectContaining({ reason: "large_line_delta", detail: "200 changed lines" }),
        expect.objectContaining({ reason: "high_risk_path:auth", detail: "1 file matched src/auth/**" }),
      ]),
    );
    expect(result.components.map((component) => component.reason)).not.toContain("large_change_size");
  });

  it.each([
    {
      name: "100 non-test files",
      files: Array.from({ length: 100 }, (_, index) => ({ path: `src/file-${index}.ts`, additions: 1, deletions: 0 })),
      expectedDetail: "100 non-test changed files, 100 non-test changed lines; reached 100 file threshold",
    },
    {
      name: "5,000 non-test changed lines",
      files: [{ path: "src/large.ts", additions: 4_000, deletions: 1_000 }],
      expectedDetail: "1 non-test changed file, 5000 non-test changed lines; reached 5000 line threshold",
    },
  ])("forces high risk for $name", ({ files, expectedDetail }) => {
    const result = scorePullRequestRisk({
      files,
      author: "priyaa",
      branchName: "feature/large-change",
      commitMessages: ["feat: expand service"],
      config: {
        thresholds: { low: 15, high: 90 },
        size: { highChangedFiles: 100, highChangedLines: 5_000 },
        paths: [],
        suppressors: [],
        aiAuthorship: { enabled: false, modifier: 0 },
      },
    });

    expect(result.score).toBe(91);
    expect(result.tier).toBe("high");
    expect(result.classifierVersion).toBe("risk-v2");
    expect(result.components).toEqual([
      expect.objectContaining({ reason: "changed_file_count" }),
      ...(files.length === 1 ? [expect.objectContaining({ reason: "large_line_delta" })] : []),
      expect.objectContaining({ reason: "large_change_size", detail: expectedDetail }),
    ]);
  });

  it("does not let a docs suppressor lower a qualifying size escalation", () => {
    const result = scorePullRequestRisk({
      files: [{ path: "docs/architecture.md", additions: 5_000, deletions: 0 }],
      author: "priyaa",
      branchName: "docs/architecture",
      commitMessages: ["docs: expand architecture"],
      config: {
        thresholds: { low: 15, high: 90 },
        size: { highChangedFiles: 100, highChangedLines: 5_000 },
        paths: [],
        suppressors: [{ ifAllMatch: ["docs/**"], ceiling: 25 }],
        aiAuthorship: { enabled: false, modifier: 0 },
      },
    });

    expect(result.score).toBe(91);
    expect(result.tier).toBe("high");
    expect(result.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "large_change_size" }),
        expect.objectContaining({ reason: "docs_or_test_suppressor", detail: "Risk suppressor ignored for a size-escalated pull request" }),
      ]),
    );
  });

  it("routes a qualifying change high when the high threshold is 100", () => {
    const result = scorePullRequestRisk({
      files: [{ path: "src/large.ts", additions: 5_000, deletions: 0 }],
      author: "priyaa",
      branchName: "feature/large-change",
      commitMessages: ["feat: expand service"],
      config: {
        thresholds: { low: 25, high: 100 },
        size: { highChangedFiles: 100, highChangedLines: 5_000 },
        paths: [],
        suppressors: [],
        aiAuthorship: { enabled: false, modifier: 0 },
      },
    });

    expect(result.score).toBe(100);
    expect(result.tier).toBe("high");
    expect(result.components).toContainEqual(expect.objectContaining({ reason: "large_change_size" }));
  });
});
