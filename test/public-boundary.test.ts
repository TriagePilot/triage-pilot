import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { scanPublicBoundary } from "../scripts/check-public-boundary.mjs";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];

describe("scanPublicBoundary", () => {
  afterAll(async () => {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("rejects hosted and SaaS runtime leakage in tracked source files", async () => {
    const repoRoot = await createTrackedRepo({
      "packages/core/src/runtime.ts": 'export const runtime = "hosted SaaS control plane";\n',
    });

    const violations = await scanPublicBoundary({ cwd: repoRoot });
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "packages/core/src/runtime.ts", rule: "content:hosted" }),
        expect.objectContaining({ path: "packages/core/src/runtime.ts", rule: "content:saas" }),
      ]),
    );
  });

  it("allows approved design, legal, and process artifacts but rejects the same content elsewhere", async () => {
    const repoRoot = await createTrackedRepo({
      "docs/specs/2026-08-26-commercial-saas-extension-design.md":
        "commercial SaaS tenant_id stripe secret-manager hosted runtime\n",
      "LICENSE": "noncommercial use notice\n",
      "AGENTS.md": "Do not add hosted-service runbooks to this repository.\n",
      "docs/operations/deployment-overlays.md":
        "Separate repositories may contain hosted-service runbooks and secret-manager integrations.\n",
      "docs/notes/leak.md": "commercial SaaS hosted runtime stripe tenant_id secret-manager\n",
    });

    const violations = await scanPublicBoundary({ cwd: repoRoot });
    expect(violations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "docs/specs/2026-08-26-commercial-saas-extension-design.md" }),
        expect.objectContaining({ path: "LICENSE" }),
        expect.objectContaining({ path: "AGENTS.md" }),
        expect.objectContaining({ path: "docs/operations/deployment-overlays.md" }),
      ]),
    );
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "docs/notes/leak.md", rule: "content:commercial" }),
        expect.objectContaining({ path: "docs/notes/leak.md", rule: "content:saas" }),
        expect.objectContaining({ path: "docs/notes/leak.md", rule: "content:hosted" }),
      ]),
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
