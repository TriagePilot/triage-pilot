import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWebApp } from "../src/app";
import { buildServices } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /health", () => {
  it("reports database readiness", async () => {
    const checkDatabase = vi.fn(async () => {});
    const app = createWebApp(buildServices({ checkDatabase }));

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "triagepilot-web" });
    expect(checkDatabase).toHaveBeenCalledOnce();
  });

  it("returns a generic 503 and closed log record when PostgreSQL is unavailable", async () => {
    const writeError = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createWebApp(
      buildServices({
        async checkDatabase() {
          throw new Error("connection refused at postgres://admin:secret@database.internal/app");
        },
      }),
    );

    const response = await app.request("/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, service: "triagepilot-web" });
    expect(writeError).toHaveBeenCalledOnce();
    const record = String(writeError.mock.calls[0]?.[0]);
    expect(Object.keys(JSON.parse(record))).toEqual(["timestamp", "level", "event", "service"]);
    expect(JSON.parse(record)).toMatchObject({
      level: "error",
      event: "health_database_failed",
      service: "web",
    });
    expect(record).not.toContain("connection refused");
    expect(record).not.toContain("postgres://");
    expect(record).not.toContain("secret");
  });
});

describe("Docker Compose self-hosting", () => {
  it("runs only PostgreSQL, web, and one worker with restart policies", async () => {
    const compose = await readFile("docker-compose.yml", "utf8");
    const services = compose.slice(compose.indexOf("services:"), compose.indexOf("\nvolumes:"));
    const names = [...services.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map((match) => match[1]);

    expect([...names].sort()).toEqual(["postgres", "web", "worker"]);
    for (const [index, name] of names.entries()) {
      const nextName = names[index + 1];
      const start = services.indexOf(`  ${name}:`);
      const end = nextName ? services.indexOf(`  ${nextName}:`, start) : services.length;
      expect(services.slice(start, end), `${name} service`).toContain("restart: unless-stopped");
    }
  });
});
