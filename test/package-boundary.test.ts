import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { scanPackageBoundary } from "../scripts/check-package-boundary.mjs";

const cleanupPaths: string[] = [];

describe("scanPackageBoundary", () => {
  afterAll(async () => {
    await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  });

  it("rejects devDependency protocol leakage and unpublished internal packages", async () => {
    const repoRoot = await createPackageBoundaryFixture({
      "packages/core/package.json": JSON.stringify(
        buildPackageManifest("@triagepilot/core", {
          devDependencies: {
            "@triagepilot/shared": "workspace:0.1.0",
            "file-dependency": "file:../fixture",
            "git-dependency": "git+https://example.com/repo.git",
            "link-dependency": "link:../fixture",
          },
        }),
        null,
        2,
      ),
    });

    const violations = await scanPackageBoundary({ cwd: repoRoot });
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "packages/core/package.json", rule: "devDependencies:shared-import" }),
        expect.objectContaining({
          path: "packages/core/package.json",
          rule: "devDependencies:forbidden-protocol:file-dependency",
        }),
        expect.objectContaining({
          path: "packages/core/package.json",
          rule: "devDependencies:forbidden-protocol:git-dependency",
        }),
        expect.objectContaining({
          path: "packages/core/package.json",
          rule: "devDependencies:forbidden-protocol:link-dependency",
        }),
      ]),
    );
  });
});

async function createPackageBoundaryFixture(overrides: Record<string, string>) {
  const repoRoot = await mkdtemp(join(tmpdir(), "triagepilot-package-boundary-"));
  cleanupPaths.push(repoRoot);
  await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2));

  const packageNames = [
    "@triagepilot/contracts",
    "@triagepilot/config",
    "@triagepilot/core",
    "@triagepilot/application",
    "@triagepilot/db",
    "@triagepilot/provider-github",
    "@triagepilot/ui",
  ] as const;

  for (const packageName of packageNames) {
    const slug = packageName.replace("@triagepilot/", "");
    const packageRoot = join(repoRoot, "packages", slug);
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "LICENSE"), "fixture\n");
    await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n");
    await writeFile(join(packageRoot, "dist", "index.d.ts"), "export {};\n");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify(buildPackageManifest(packageName), null, 2));
  }

  await mkdir(join(repoRoot, "packages", "db", "migrations"), { recursive: true });
  await writeFile(join(repoRoot, "packages", "db", "migrations", "0006_decision_outbox.sql"), "-- fixture\n");
  await writeFile(join(repoRoot, "packages", "ui", "dist", "styles.css"), "body{}\n");

  for (const [relativePath, content] of Object.entries(overrides)) {
    await writeFile(join(repoRoot, relativePath), content);
  }

  return repoRoot;
}

function buildPackageManifest(
  packageName: string,
  overrides: {
    devDependencies?: Record<string, string>;
  } = {},
) {
  const files = packageName === "@triagepilot/db" ? ["dist", "migrations", "LICENSE"] : ["dist", "LICENSE"];
  const exports =
    packageName === "@triagepilot/ui"
      ? {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./styles.css": "./dist/styles.css",
        }
      : { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } };

  return {
    name: packageName,
    version: "0.1.0",
    type: "module",
    files,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports,
    publishConfig: { access: "public" },
    devDependencies: overrides.devDependencies ?? {},
  };
}
