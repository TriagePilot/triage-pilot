import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  findContentViolations,
  findPathViolations,
  formatViolation,
  scanPublicBoundary,
} from "../../../scripts/check-public-boundary.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const forbiddenProviderText = ["hyper", "drive wrangler", ".toml cloudflare", " queues cloudflare", " cron"].join("");
const localWorkspacePath = ["", "Users", "example", "triage-pilot"].join("/");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("public boundary matching", () => {
  it.each([
    [["wrangler", ".toml"].join(""), "path:wrangler"],
    ["deploy/wrangler.production.json", "path:wrangler"],
    ["cloudflare/worker.ts", "path:provider-directory"],
    ["ops/private-runbook.md", "path:private-material"],
  ])("reports the path rule for %s", (path, rule) => {
    expect(findPathViolations(path)).toEqual([{ path, rule }]);
  });

  it.each([
    [`Worktree: ${localWorkspacePath}`, "content:local-workspace-path"],
    [["HYPER", "DRIVE binding"].join(""), "content:provider-binding"],
    [["copy wrangler", ".toml"].join(""), "content:provider-config"],
    [["Cloudflare", " Queues consumer"].join(""), "content:provider-queue"],
    [["Cloudflare", " Cron trigger"].join(""), "content:provider-cron"],
  ])("reports only a rule identifier for forbidden authored text", (content, rule) => {
    const violations = findContentViolations("docs/operator.md", content);

    expect(violations).toEqual([{ path: "docs/operator.md", rule }]);
    expect(formatViolation(violations[0]!)).toBe(`docs/operator.md\t${rule}`);
    expect(formatViolation(violations[0]!)).not.toContain(content);
  });

  it("exempts content only in the canonical specification and generated root lockfile", () => {
    expect(findContentViolations("docs/specs/2026-07-07-open-source-self-hosting-design.md", forbiddenProviderText)).toEqual([]);
    expect(findContentViolations("pnpm-lock.yaml", forbiddenProviderText)).toEqual([]);
    expect(findContentViolations("nested/pnpm-lock.yaml", forbiddenProviderText)).toHaveLength(4);
    expect(findPathViolations("cloudflare/pnpm-lock.yaml")).toEqual([
      { path: "cloudflare/pnpm-lock.yaml", rule: "path:provider-directory" },
    ]);
  });
});

describe("public boundary scan", () => {
  it("scans only tracked text smaller than 2 MiB and never reveals matching content", async () => {
    const repository = await mkdtemp(join(tmpdir(), "triagepilot-boundary-"));
    temporaryDirectories.push(repository);
    await execFileAsync("git", ["init", "-q"], { cwd: repository });
    await mkdir(join(repository, "docs", "specs"), { recursive: true });
    await mkdir(join(repository, "nested"), { recursive: true });
    await writeFile(join(repository, "README.md"), ["Cloudflare", " Queues secret-payload-marker\n"].join(""));
    await writeFile(join(repository, "local-path.md"), `Worktree: ${localWorkspacePath}\n`);
    await writeFile(join(repository, "wrangler" + ".toml"), "safe = true\n");
    await writeFile(join(repository, "pnpm-lock.yaml"), ["hyper", "drive\n"].join(""));
    await writeFile(join(repository, "nested", "pnpm-lock.yaml"), ["hyper", "drive\n"].join(""));
    await writeFile(
      join(repository, "docs", "specs", "2026-07-07-open-source-self-hosting-design.md"),
      forbiddenProviderText,
    );
    await writeFile(join(repository, "large.txt"), Buffer.concat([Buffer.from(["hyper", "drive\n"].join("")), Buffer.alloc(2 * 1024 * 1024)]));
    await writeFile(join(repository, "binary.dat"), Buffer.from(["hyper", "drive\0secret-payload-marker"].join("")));
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await mkdir(join(repository, "terraform"));
    await writeFile(join(repository, "terraform", "untracked.tf"), ["hyper", "drive\n"].join(""));

    const violations = await scanPublicBoundary({ cwd: repository });
    const output = violations.map(formatViolation).join("\n");

    expect(violations).toEqual([
      { path: "README.md", rule: "content:provider-queue" },
      { path: "local-path.md", rule: "content:local-workspace-path" },
      { path: "nested/pnpm-lock.yaml", rule: "content:provider-binding" },
      { path: "wrangler" + ".toml", rule: "path:wrangler" },
    ]);
    expect(output).not.toContain("secret-payload-marker");
    expect(output).not.toContain("terraform/untracked.tf");
  });
});
