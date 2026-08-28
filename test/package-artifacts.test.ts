import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(import.meta.dirname, "..");
const publishedPackages = [
  "@triagepilot/contracts",
  "@triagepilot/config",
  "@triagepilot/core",
  "@triagepilot/application",
  "@triagepilot/db",
  "@triagepilot/provider-github",
  "@triagepilot/ui",
] as const;
const licenseId = "FSL-1.1-Apache-2.0";
const staleAgplPattern = /AGPL-3\.0|GNU Affero General Public License|Affero GPL/i;

type PublishedPackageName = (typeof publishedPackages)[number];

type PackedPackage = {
  name: PublishedPackageName;
  rootDir: string;
  tarballPath: string;
  extractedDir: string;
  packedManifest: Record<string, unknown>;
  fileEntries: string[];
  dependencyVersions: Record<string, string>;
  typeEntry: string;
  importEntry: string;
};

let packDirectory: string;
let packedPackages: PackedPackage[];
let rootLicense: string;

describe("published package artifacts", () => {
  beforeAll(async () => {
    packDirectory = await mkdtemp(join(tmpdir(), "triagepilot-artifacts-"));
    rootLicense = await readFile(join(repoRoot, "LICENSE"), "utf8");
    await runPnpm(["build"]);
    packedPackages = [];

    for (const packageName of publishedPackages) {
      const packageSlug = packageName.replace("@triagepilot/", "");
      const packageRoot = join(repoRoot, "packages", packageSlug);
      await runPnpm(["pack", "--pack-destination", packDirectory], packageRoot);

      const tarballName = `${packageName.replace("@triagepilot/", "triagepilot-").replace(/\//g, "-")}-${await readVersion(
        join(packageRoot, "package.json"),
      )}.tgz`;
      const tarballPath = join(packDirectory, tarballName);
      const extractedDir = join(packDirectory, `${packageSlug}-package`);
      await mkdir(extractedDir, { recursive: true });
      await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractedDir, "--strip-components=1"], {
        cwd: repoRoot,
      });

      const packedManifest = JSON.parse(await readFile(join(extractedDir, "package.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const { stdout: fileList } = await execFileAsync("tar", ["-tzf", tarballPath], {
        cwd: repoRoot,
        maxBuffer: 16 * 1024 * 1024,
      });

      const exportsField = readRecord(packedManifest.exports, `${packageName} exports`);
      const dotExport = readRecord(exportsField["."], `${packageName} exports["."]`);
      packedPackages.push({
        name: packageName,
        rootDir: packageRoot,
        tarballPath,
        extractedDir,
        packedManifest,
        fileEntries: fileList
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => entry.replace(/^package\//, "")),
        dependencyVersions: collectDependencyVersions(packedManifest),
        typeEntry: readString(dotExport.types, `${packageName} exports["."].types`),
        importEntry: readString(dotExport.import, `${packageName} exports["."].import`),
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (packDirectory) await rm(packDirectory, { recursive: true, force: true });
  });

  it("packs synchronized compiled artifacts without source or private graph leakage", async () => {
    const rootVersion = await readVersion(join(repoRoot, "package.json"));

    for (const artifact of packedPackages) {
      expect(readString(artifact.packedManifest.version, `${artifact.name} version`)).toBe(rootVersion);
      expect(readString(artifact.packedManifest.license, `${artifact.name} license`)).toBe(licenseId);
      expect(JSON.stringify(artifact.packedManifest), `${artifact.name} packed metadata`).not.toMatch(staleAgplPattern);
      expect(artifact.packedManifest.private).not.toBe(true);
      expect(readString(artifact.packedManifest.main, `${artifact.name} main`)).toBe("./dist/index.js");
      expect(readString(artifact.packedManifest.types, `${artifact.name} types`)).toBe("./dist/index.d.ts");
      expect(artifact.typeEntry).toBe("./dist/index.d.ts");
      expect(artifact.importEntry).toBe("./dist/index.js");
      expect(readFiles(artifact.packedManifest.files, `${artifact.name} files`)).toContain("dist");
      expect(artifact.fileEntries).toContain("package.json");
      expect(artifact.fileEntries).toContain("LICENSE");
      await expect(readFile(join(artifact.extractedDir, "LICENSE"), "utf8")).resolves.toBe(rootLicense);
      expect(rootLicense, "root LICENSE").toContain(licenseId);
      expect(rootLicense, "root LICENSE").not.toMatch(staleAgplPattern);
      expect(artifact.fileEntries.some((entry) => entry.startsWith("dist/"))).toBe(true);
      expect(artifact.fileEntries.some((entry) => entry.startsWith("src/"))).toBe(false);

      if (artifact.name === "@triagepilot/db") {
        expect(readFiles(artifact.packedManifest.files, `${artifact.name} files`)).toContain("migrations");
        expect(artifact.fileEntries.some((entry) => entry.startsWith("migrations/"))).toBe(true);
      }

      for (const [dependencyName, version] of Object.entries(artifact.dependencyVersions)) {
        expect(version, `${artifact.name} -> ${dependencyName}`).not.toMatch(/^(workspace|file|link):/);
        if (publishedPackages.includes(dependencyName as PublishedPackageName)) {
          expect(version, `${artifact.name} -> ${dependencyName}`).toBe(rootVersion);
        }
      }

      const distTypePath = join(artifact.extractedDir, artifact.typeEntry.replace(/^\.\//, ""));
      const typeContent = await readFile(distTypePath, "utf8");
      expect(typeContent).not.toMatch(/@triagepilot\/shared/);
      expect(typeContent).not.toMatch(/(?:^|["'])\.\.?\/src\//m);
      expect(typeContent).not.toMatch(/\/Users\/|\/home\//);

      const packageHash = createHash("sha256")
        .update(await readFile(artifact.tarballPath))
        .digest("hex");
      expect(packageHash).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 180_000);

  it("can be consumed from compiled runtime and declaration entrypoints", async () => {
    const consumerRoot = join(packDirectory, "consumer");
    await mkdir(consumerRoot, { recursive: true });
    await writeFile(
      join(consumerRoot, "package.json"),
      JSON.stringify(
        {
          name: "artifact-consumer",
          private: true,
          type: "module",
          dependencies: collectExternalConsumerDependencies(packedPackages),
          devDependencies: {
            "@types/react": "^18.3.18",
            "@types/react-dom": "^18.3.5",
            "react": "^18.3.1",
            "react-dom": "^18.3.1",
            "typescript": "^5.7.2",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(consumerRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            strict: true,
            noEmit: true,
          },
          include: ["index.ts"],
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(consumerRoot, "index.ts"),
      [
        'import type { RoutingJobPayload } from "@triagepilot/contracts";',
        'import * as Contracts from "@triagepilot/contracts";',
        'import * as Config from "@triagepilot/config";',
        'import * as Core from "@triagepilot/core";',
        'import * as Application from "@triagepilot/application";',
        'import * as Db from "@triagepilot/db";',
        'import * as ProviderGitHub from "@triagepilot/provider-github";',
        'import * as Ui from "@triagepilot/ui";',
        "",
        "void Contracts;",
        "void Config;",
        "void Core;",
        "void Application;",
        "void Db;",
        "void ProviderGitHub;",
        "void Ui;",
        "const job: RoutingJobPayload | null = null;",
        "void job;",
      ].join("\n"),
    );

    await runPnpm(["install"], consumerRoot);

    const nodeModulesRoot = join(consumerRoot, "node_modules", "@triagepilot");
    await mkdir(nodeModulesRoot, { recursive: true });
    for (const artifact of packedPackages) {
      await cp(artifact.extractedDir, join(nodeModulesRoot, artifact.name.replace("@triagepilot/", "")), {
        recursive: true,
      });
    }

    await execFileAsync(
      "node",
      [
        "--input-type=module",
        "--eval",
        [
          'await import("@triagepilot/contracts");',
          'await import("@triagepilot/config");',
          'await import("@triagepilot/core");',
          'await import("@triagepilot/application");',
          'await import("@triagepilot/db");',
          'await import("@triagepilot/provider-github");',
          'await import("@triagepilot/ui");',
        ].join("\n"),
      ],
      { cwd: consumerRoot, env: pnpmEnv() },
    );

    await execFileAsync(
      "pnpm",
      ["exec", "tsc", "-p", "tsconfig.json"],
      { cwd: consumerRoot, env: pnpmEnv(), maxBuffer: 16 * 1024 * 1024 },
    );
  }, 180_000);
});

async function runPnpm(args: string[], cwd = repoRoot) {
  await execFileAsync("pnpm", args, {
    cwd,
    env: pnpmEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });
}

function pnpmEnv() {
  return {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH ?? ""]
      .filter(Boolean)
      .join(":"),
  };
}

async function readVersion(path: string) {
  const manifest = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
  return readString(manifest.version, `${path} version`);
}

function readString(value: unknown, label: string) {
  if (typeof value !== "string") throw new TypeError(`Expected ${label} to be a string.`);
  return value;
}

function readRecord(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function readFiles(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`Expected ${label} to be a string array.`);
  }
  return value as string[];
}

function collectDependencyVersions(manifest: Record<string, unknown>) {
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
  const versions: Record<string, string> = {};

  for (const section of sections) {
    const value = manifest[section];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [dependencyName, version] of Object.entries(value)) {
      versions[dependencyName] = readString(version, `${section}.${dependencyName}`);
    }
  }

  return versions;
}

function collectExternalConsumerDependencies(artifacts: PackedPackage[]) {
  const externalDependencies: Record<string, string> = {};

  for (const artifact of artifacts) {
    for (const [dependencyName, version] of Object.entries(artifact.dependencyVersions)) {
      if (publishedPackages.includes(dependencyName as PublishedPackageName)) continue;
      externalDependencies[dependencyName] = version;
    }
  }

  return externalDependencies;
}
