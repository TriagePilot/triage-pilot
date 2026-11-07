import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createWebApp } from "../src/app";
import { buildServices } from "./helpers";

describe("static administration UI", () => {
  it("serves the administration app at the documented root path", async () => {
    const app = createWebApp(buildServices(), {
      async readAsset(path) {
        if (path === "index.html") {
          return { body: "<!doctype html><div id=\"root\"></div>", contentType: "text/html; charset=utf-8" };
        }
        return null;
      },
    });

    const response = await app.request("/#analytics");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("id=\"root\"");
  });

  it("serves PNG asset bytes unchanged", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const app = createWebApp(buildServices(), {
      async readAsset(path) {
        if (path === "assets/triage-pilot-logo.png") {
          return { body: pngBytes, contentType: "image/png" };
        }
        return null;
      },
    });

    const response = await app.request("/assets/triage-pilot-logo.png");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);
  });
});

it("serves every locally declared font and its license through production asset routes", async () => {
  const css = await readFile(new URL("../src/admin/styles.css", import.meta.url), "utf8");
  const urls = [...css.matchAll(/url\(['"]([^'"]+\.ttf)['"]\)/g)].map(match => match[1]!);
  expect(urls).toHaveLength(3);
  const publicRoot = path.resolve("apps/web/public");
  const app = createWebApp(buildServices(), { async readAsset(assetPath) {
    try { return {body: await readFile(path.join(publicRoot, assetPath)), contentType:"application/octet-stream"}; }
    catch { return null; }
  }});
  for (const url of urls) {
    const response = await app.request(url);
    expect(response.status, url).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100_000);
  }
  for (const name of ["inter", "geist", "geistmono"]) {
    const response = await app.request(`/assets/fonts/${name}-OFL.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("SIL OPEN FONT LICENSE");
  }
});
