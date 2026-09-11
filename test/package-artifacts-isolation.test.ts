import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const rootDistSentinel = join(repoRoot, "packages", "ui", "dist", ".artifact-isolation-sentinel");
const sentinelContent = "artifact verification must not rebuild root dist\n";

describe("package artifact verification isolation", () => {
  beforeAll(async () => {
    await mkdir(join(repoRoot, "packages", "ui", "dist"), { recursive: true });
    await writeFile(rootDistSentinel, sentinelContent);
  });

  afterAll(async () => {
    await rm(rootDistSentinel, { force: true });
  });

  it("preserves a root dist sentinel while artifact verification runs", async () => {
    await runPnpm(["vitest", "run", "test/package-artifacts.test.ts"]);

    await expect(readFile(rootDistSentinel, "utf8")).resolves.toBe(sentinelContent);
  }, 240_000);
});

async function runPnpm(args: string[]) {
  await execFileAsync("pnpm", args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [resolve(process.execPath, ".."), process.env.PATH ?? ""].filter(Boolean).join(":"),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
}
