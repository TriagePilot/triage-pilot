import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("production runtime manifests", () => {
  it("runs compiled web and worker entrypoints without tsx", async () => {
    const web = await readManifest("apps/web/package.json");
    const worker = await readManifest("apps/worker/package.json");

    expect(web.scripts.start).toBe("node dist/server.js");
    expect(worker.scripts.start).toBe("node dist/main.js");
    expect(web.scripts.build).toContain("tsconfig.build.json");
    expect(worker.scripts.build).toContain("tsconfig.build.json");
  });

  it("keeps browser and build tooling out of the production dependency graph", async () => {
    const web = await readManifest("apps/web/package.json");
    const provider = await readManifest("packages/provider-github/package.json");

    for (const dependency of ["@triagepilot/ui", "@vitejs/plugin-react", "react", "react-dom", "vite"]) {
      expect(web.dependencies).not.toHaveProperty(dependency);
      expect(web.devDependencies).toHaveProperty(dependency);
    }
    expect(provider.dependencies).not.toHaveProperty("@types/node");
    expect(provider.devDependencies).toHaveProperty("@types/node");
  });

  it("builds the private shared package into a Node-compatible dist entrypoint", async () => {
    const shared = await readManifest("packages/shared/package.json");

    expect(shared.main).toBe("./dist/index.js");
    expect(shared.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    });
    expect(shared.scripts.build).toContain("tsc -p tsconfig.json");
  });

  it("aligns development types with the Node 24 production baseline", async () => {
    const root = await readManifest("package.json");
    const provider = await readManifest("packages/provider-github/package.json");

    expect(root.devDependencies["@types/node"]).toMatch(/^\^24\./);
    expect(provider.devDependencies["@types/node"]).toMatch(/^\^24\./);
  });
});

async function readManifest(relativePath: string) {
  return JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}
