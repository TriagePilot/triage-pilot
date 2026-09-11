import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { scanPublicBoundary } from "../scripts/check-public-boundary.mjs";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];
const termAlpha = ["hos", "ted"].join("");
const termBeta = ["Sa", "aS"].join("");
const termGamma = ["com", "mercial"].join("");
const termDelta = ["tenant", "_", "id"].join("");
const termEpsilon = ["str", "ipe"].join("");
const termZeta = ["secret", "-", "manager"].join("");
const ruleAlpha = ["content", termAlpha].join(":");
const ruleBeta = ["content", termBeta.toLowerCase()].join(":");
const ruleGamma = ["content", termGamma].join(":");
const ruleStaleLicense = ["content", "active-agpl"].join(":");
const licenseId = "FSL-1.1-Apache-2.0";
const fslTitle = "Functional Source License, Version 1.1, Apache 2.0 Future License";
const approvedDesignPath = [
  "docs",
  "specs",
  ["2026", "08", "26"].join("-") + "-" + ["com", "mercial"].join("") + "-" + ["sa", "as"].join("") + "-extension-design.md",
].join("/");

describe("scanPublicBoundary", () => {
  afterAll(async () => {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  });

  it(["rejects", termAlpha, "and", termBeta, "runtime leakage in tracked source files"].join(" "), async () => {
    const repoRoot = await createTrackedRepo({
      "packages/core/src/runtime.ts": `export const runtime = "${[termAlpha, termBeta, "control plane"].join(" ")}";\n`,
    });

    const violations = await scanPublicBoundary({ cwd: repoRoot });
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "packages/core/src/runtime.ts", rule: ruleAlpha }),
        expect.objectContaining({ path: "packages/core/src/runtime.ts", rule: ruleBeta }),
      ]),
    );
  });

  it("allows approved design, legal, and process artifacts but rejects the same content elsewhere", async () => {
    const repoRoot = await createTrackedRepo({
      [approvedDesignPath]: `${[termGamma, termBeta, termDelta, termEpsilon, termZeta, termAlpha, "runtime"].join(" ")}\n`,
      "LICENSE": `non${termGamma} use notice\n`,
      "AGENTS.md": `Do not add ${[termAlpha, "service"].join("-")} runbooks to this repository.\n`,
      "docs/operations/deployment-overlays.md":
        `Separate repositories may contain ${[termAlpha, "service"].join("-")} runbooks and ${termZeta} integrations.\n`,
      "docs/notes/leak.md":
        `${[termGamma, termBeta, termAlpha, "runtime", termEpsilon, termDelta, termZeta].join(" ")}\n`,
    });

    const violations = await scanPublicBoundary({ cwd: repoRoot });
    expect(violations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: approvedDesignPath }),
        expect.objectContaining({ path: "LICENSE" }),
        expect.objectContaining({ path: "AGENTS.md" }),
        expect.objectContaining({ path: "docs/operations/deployment-overlays.md" }),
      ]),
    );
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "docs/notes/leak.md", rule: ruleGamma }),
        expect.objectContaining({ path: "docs/notes/leak.md", rule: ruleBeta }),
        expect.objectContaining({ path: "docs/notes/leak.md", rule: ruleAlpha }),
      ]),
    );
  });

  it("requires FSL licensing and closed external-contribution governance", async () => {
    const repoRoot = await createTrackedRepo({
      "LICENSE": `${fslTitle}\n${licenseId}\nCopyright 2026 Miroslav Babjak\n`,
      "README.md":
        `${licenseId}\nTriagePilot is Fair Source and source-available. Internal self-hosted use is permitted. Each version converts to Apache 2.0 on its second anniversary. The separate SaaS repository is proprietary.\n`,
      "CONTRIBUTING.md":
        "External code and documentation contributions are not merged. Automated dependency updates require provenance and license-review.\n",
      ".github/PULL_REQUEST_TEMPLATE.md": "External code and documentation contributions are not merged.\n",
    });

    await expect(scanPublicBoundary({ cwd: repoRoot })).resolves.toEqual([]);
  });

  it("rejects active stale AGPL licensing claims outside preserved historical or third-party material", async () => {
    const previousLicense = ["A", "GPL-3.0"].join("");
    const repoRoot = await createTrackedRepo({
      "LICENSE": `${fslTitle}\n${licenseId}\nCopyright 2026 Miroslav Babjak\n`,
      "README.md":
        `${licenseId}\nTriagePilot is Fair Source and source-available. Internal self-hosted use is permitted. Each version converts to Apache 2.0 on its second anniversary. The separate SaaS repository is proprietary.\n`,
      "CONTRIBUTING.md":
        "External code and documentation contributions are not merged. Automated dependency updates require provenance and license-review.\n",
      ".github/PULL_REQUEST_TEMPLATE.md": "External code and documentation contributions are not merged.\n",
      "docs/notes/license.md": `TriagePilot is licensed as ${previousLicense}.\n`,
      "docs/specs/2026-08-26-legacy-context.md": `Historical note: older wording said ${previousLicense}.\n`,
    });

    const violations = await scanPublicBoundary({ cwd: repoRoot });
    expect(violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "docs/notes/license.md", rule: ruleStaleLicense })]),
    );
    expect(violations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "docs/specs/2026-08-26-legacy-context.md" })]),
    );
  });
});

async function createTrackedRepo(files: Record<string, string>) {
  const repoRoot = await mkdtemp(join(tmpdir(), "triagepilot-public-boundary-"));
  cleanupPaths.push(repoRoot);

  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(join(repoRoot, relativePath, ".."), { recursive: true });
    await writeFile(join(repoRoot, relativePath), content);
  }

  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Codex"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "codex@example.com"], { cwd: repoRoot });
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repoRoot });

  return repoRoot;
}
