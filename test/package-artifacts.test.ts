import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
const publishedAt = "2026-08-28T10:20:30.000Z";
const futureLicenseEffectiveAt = "2028-08-28T10:20:30.000Z";
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

type ArtifactRegistry = {
  url: string;
  close: () => Promise<void>;
};

let packDirectory: string;
let packedPackages: PackedPackage[];
let rootLicense: string;
let artifactVersion: string;
let artifactWorkspace: string;
let artifactRegistry: ArtifactRegistry;

describe("published package artifacts", () => {
  beforeAll(async () => {
    packDirectory = await mkdtemp(join(tmpdir(), "triagepilot-artifacts-"));
    artifactWorkspace = await createArtifactWorkspace();
    rootLicense = await readFile(join(artifactWorkspace, "LICENSE"), "utf8");
    artifactVersion = await readVersion(join(artifactWorkspace, "package.json"));
    await runPnpm(["install", "--frozen-lockfile"], artifactWorkspace);
    await runPnpm(["build"], artifactWorkspace);
    packedPackages = [];

    for (const packageName of publishedPackages) {
      const packageSlug = packageName.replace("@triagepilot/", "");
      const packageRoot = join(artifactWorkspace, "packages", packageSlug);
      await runPnpm(["pack", "--pack-destination", packDirectory], packageRoot, {
        TRIAGEPILOT_ARTIFACT_PUBLISHED_AT: publishedAt,
        TRIAGEPILOT_ARTIFACT_FUTURE_LICENSE_EFFECTIVE_AT: futureLicenseEffectiveAt,
      });

      const tarballName = `${packageName.replace("@triagepilot/", "triagepilot-").replace(/\//g, "-")}-${await readVersion(
        join(packageRoot, "package.json"),
      )}.tgz`;
      const tarballPath = join(packDirectory, tarballName);
      const extractedDir = join(packDirectory, `${packageSlug}-package`);
      await mkdir(extractedDir, { recursive: true });
      await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractedDir, "--strip-components=1"], {
        cwd: artifactWorkspace,
      });

      const packedManifest = JSON.parse(await readFile(join(extractedDir, "package.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const { stdout: fileList } = await execFileAsync("tar", ["-tzf", tarballPath], {
        cwd: artifactWorkspace,
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

    artifactRegistry = await startArtifactRegistry(packedPackages, artifactVersion);
  }, 180_000);

  afterAll(async () => {
    if (artifactRegistry) await artifactRegistry.close();
    if (packDirectory) await rm(packDirectory, { recursive: true, force: true });
    if (artifactWorkspace) await rm(artifactWorkspace, { recursive: true, force: true });
  });

  it("packs synchronized compiled artifacts without source or private graph leakage", async () => {
    const packedMetadataDates = new Set(
      packedPackages.map((artifact) =>
        [
          readString(artifact.packedManifest.publishedAt, `${artifact.name} publishedAt`),
          readString(
            artifact.packedManifest.futureLicenseEffectiveAt,
            `${artifact.name} futureLicenseEffectiveAt`,
          ),
        ].join(" -> "),
      ),
    );

    expect(packedPackages).toHaveLength(publishedPackages.length);
    expect(packedMetadataDates).toEqual(new Set([`${publishedAt} -> ${futureLicenseEffectiveAt}`]));
    for (const artifact of packedPackages) {
      expect(readString(artifact.packedManifest.version, `${artifact.name} version`)).toBe(artifactVersion);
      expect(readString(artifact.packedManifest.license, `${artifact.name} license`)).toBe(licenseId);
      expect(readString(artifact.packedManifest.publishedAt, `${artifact.name} publishedAt`)).toBe(publishedAt);
      expect(readString(artifact.packedManifest.futureLicenseEffectiveAt, `${artifact.name} futureLicenseEffectiveAt`)).toBe(
        futureLicenseEffectiveAt,
      );
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

      const sourceManifest = JSON.parse(await readFile(join(artifact.rootDir, "package.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(sourceManifest.publishedAt, `${artifact.name} source publishedAt`).toBeUndefined();
      expect(sourceManifest.futureLicenseEffectiveAt, `${artifact.name} source futureLicenseEffectiveAt`).toBeUndefined();

      for (const [dependencyName, version] of Object.entries(artifact.dependencyVersions)) {
        expect(version, `${artifact.name} -> ${dependencyName}`).not.toMatch(/^(workspace|file|link):/);
        if (publishedPackages.includes(dependencyName as PublishedPackageName)) {
          expect(version, `${artifact.name} -> ${dependencyName}`).toBe(artifactVersion);
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
          dependencies: Object.fromEntries(publishedPackages.map((packageName) => [packageName, artifactVersion])),
          devDependencies: {
            "@types/node": "^22.10.2",
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
    await writeFile(join(consumerRoot, ".npmrc"), `@triagepilot:registry=${artifactRegistry.url}\n`);
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
    const consumerLock = await readFile(join(consumerRoot, "pnpm-lock.yaml"), "utf8");
    expect(consumerLock).not.toMatch(/(?:^|\s)(?:workspace|link|file):/m);
    expect(consumerLock).not.toMatch(/(?:^|[\s:{])(git\+|github:|git@)/m);
    expect(consumerLock).not.toContain(repoRoot);
    for (const artifact of packedPackages) {
      expect(consumerLock).toContain(`${artifactRegistry.url}/tarballs/${basename(artifact.tarballPath)}`);
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

    await runPnpm(["exec", "tsc", "-p", "tsconfig.json"], consumerRoot);
  }, 180_000);
});

async function runPnpm(args: string[], cwd = repoRoot, extraEnv: Record<string, string> = {}) {
  try {
    await execFileAsync("pnpm", args, {
      cwd,
      env: pnpmEnv(extraEnv),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    throw new Error(`pnpm ${args.join(" ")} failed\n${stderr}`, { cause: error });
  }
}

async function createArtifactWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), "triagepilot-artifact-workspace-"));
  await cp(repoRoot, workspace, {
    recursive: true,
    filter: (source) => ![".git", ".superpowers", "dist", "node_modules"].includes(source.split("/").at(-1) ?? ""),
  });
  return workspace;
}

async function startArtifactRegistry(artifacts: PackedPackage[], version: string): Promise<ArtifactRegistry> {
  const entries = await Promise.all(
    artifacts.map(async (artifact) => ({
      ...artifact,
      tarball: await readFile(artifact.tarballPath),
    })),
  );
  let baseUrl = "";
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", baseUrl).pathname;
    const packageName = decodeURIComponent(pathname.slice(1));
    const packageEntry = entries.find((entry) => entry.name === packageName);
    if (packageEntry) {
      const manifest = {
        ...packageEntry.packedManifest,
        dist: {
          tarball: `${baseUrl}/tarballs/${encodeURIComponent(basename(packageEntry.tarballPath))}`,
          shasum: createHash("sha1").update(packageEntry.tarball).digest("hex"),
        },
      };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: packageEntry.name,
          "dist-tags": { latest: version },
          versions: { [version]: manifest },
        }),
      );
      return;
    }

    const tarballName = decodeURIComponent(pathname.replace(/^\/tarballs\//, ""));
    const tarballEntry = entries.find((entry) => basename(entry.tarballPath) === tarballName);
    if (tarballEntry) {
      response.setHeader("content-type", "application/octet-stream");
      response.end(tarballEntry.tarball);
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Temporary artifact registry did not bind a TCP port.");
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    url: baseUrl,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose()))),
  };
}

function pnpmEnv(extraEnv: Record<string, string> = {}) {
  return {
    ...process.env,
    ...extraEnv,
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
