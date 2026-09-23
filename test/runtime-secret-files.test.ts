import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runtime secret file preparation", () => {
  it("keeps the host directory private while making mounted files readable by the non-root runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "triagepilot-runtime-secrets-"));
    temporaryDirectories.push(root);
    const secretDirectory = join(root, "private");
    await mkdir(secretDirectory, { mode: 0o700 });
    const secretFiles = ["private-key.pem", "webhook-secret", "admin-password", "session-secret"]
      .map((name) => join(secretDirectory, name));

    for (const path of secretFiles) {
      await writeFile(path, "test-secret", { mode: 0o600 });
      await chmod(path, 0o600);
    }

    const result = await execFileAsync(process.execPath, [
      new URL("../scripts/prepare-runtime-secret-files.mjs", import.meta.url).pathname,
      ...secretFiles,
    ]).catch((error: NodeJS.ErrnoException & { stderr?: string }) => ({
      stderr: error.stderr ?? error.message,
      exitCode: error.code,
    }));

    expect(result).not.toHaveProperty("exitCode");
    expect((await stat(secretDirectory)).mode & 0o777).toBe(0o700);
    for (const path of secretFiles) {
      expect((await stat(path)).mode & 0o777).toBe(0o444);
    }
  });
});
