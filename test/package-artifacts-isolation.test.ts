import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const uiEntrypoint = join(repoRoot, "packages", "ui", "dist", "index.js");

describe("package artifact verification isolation", () => {
  beforeAll(async () => {
    await runPnpm(["build"]);
  }, 180_000);

  afterAll(async () => {
    await runPnpm(["build"]);
  }, 180_000);

  it("keeps the public UI entrypoint available while artifact verification runs", async () => {
    let entrypointWasUnavailable = false;
    const monitor = setInterval(() => {
      void access(uiEntrypoint).catch(() => {
        entrypointWasUnavailable = true;
      });
    }, 2);

    try {
      await runPnpm(["vitest", "run", "test/package-artifacts.test.ts"]);
    } finally {
      clearInterval(monitor);
    }

    expect(entrypointWasUnavailable).toBe(false);
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
