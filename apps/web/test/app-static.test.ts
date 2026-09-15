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

    const response = await app.request("/");

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
