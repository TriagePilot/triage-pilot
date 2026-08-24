import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createWebApp } from "../src/app";
import { createLoginThrottle } from "../src/auth/login-throttle";
import { createSessionToken, verifySessionToken } from "../src/auth/session";
import { buildServices } from "./helpers";

const loginBody = { username: "admin", password: "correct-password" };

describe("administrator authentication", () => {
  it("logs in with a 12-hour strict HttpOnly session cookie", async () => {
    const app = createWebApp(buildServices());
    const response = await login(app);

    expect(response.status).toBe(204);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("triagepilot_session=");
    expect(cookie).toContain("Max-Age=43200");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
  });

  it("rejects invalid, expired, and secret-rotation sessions", () => {
    const now = new Date("2026-08-18T10:00:00.000Z");
    const token = createSessionToken({ username: "admin", now, secret: "a".repeat(32) });

    expect(verifySessionToken({ token, username: "admin", now, secret: "a".repeat(32) })).toBe(true);
    expect(
      verifySessionToken({
        token,
        username: "admin",
        now: new Date(now.getTime() + 43_200_001),
        secret: "a".repeat(32),
      }),
    ).toBe(false);
    expect(verifySessionToken({ token, username: "admin", now, secret: "b".repeat(32) })).toBe(false);
    expect(verifySessionToken({ token: `${token}x`, username: "admin", now, secret: "a".repeat(32) })).toBe(false);
    expect(verifySessionToken({ token: `${token}!`, username: "admin", now, secret: "a".repeat(32) })).toBe(false);
  });

  it("rejects same-length noncanonical payload and signature aliases", () => {
    const now = new Date("2026-08-18T10:00:00.000Z");
    const secret = "a".repeat(32);
    const token = createSessionToken({ username: "admin", now, secret });
    const [payload = "", signature = ""] = token.split(".");
    const aliasedPayload = nonCanonicalBase64UrlAlias(payload);
    const payloadAliasToken = `${aliasedPayload}.${createHmac("sha256", secret).update(aliasedPayload).digest("base64url")}`;
    const signatureAliasToken = `${payload}.${nonCanonicalBase64UrlAlias(signature)}`;

    expect(verifySessionToken({ token: payloadAliasToken, username: "admin", now, secret })).toBe(false);
    expect(verifySessionToken({ token: signatureAliasToken, username: "admin", now, secret })).toBe(false);
  });

  it("rejects a noncanonical session alias at the protected API boundary", async () => {
    const now = new Date("2026-08-18T10:00:00.000Z");
    const secret = "s".repeat(32);
    const token = createSessionToken({ username: "admin", now, secret });
    const [payload = "", signature = ""] = token.split(".");
    const alias = `${payload}.${nonCanonicalBase64UrlAlias(signature)}`;
    const app = createWebApp(buildServices());

    const response = await app.request("/api/operations/overview", {
      headers: { cookie: `triagepilot_session=${alias}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("locks one username and source address after five failures for 15 minutes", async () => {
    let now = new Date("2026-08-18T10:00:00.000Z");
    const app = createWebApp(buildServices({ now: () => now }));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(app, { username: "admin", password: "wrong-password" });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "invalid credentials" });
    }

    const lockedResponse = await login(app);
    expect(lockedResponse.status).toBe(401);
    expect(await lockedResponse.json()).toEqual({ error: "invalid credentials" });

    now = new Date(now.getTime() + 15 * 60 * 1000);
    expect((await login(app)).status).toBe(204);
  });

  it("keys throttling by both username and source address and clears failures on success", () => {
    const throttle = createLoginThrottle();
    const now = new Date("2026-08-18T10:00:00.000Z");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      throttle.recordFailure("admin", "203.0.113.8", now);
    }

    expect(throttle.check("admin", "203.0.113.8", now)).toBe(false);
    expect(throttle.check("admin", "203.0.113.9", now)).toBe(true);
    expect(throttle.check("other", "203.0.113.8", now)).toBe(true);
    throttle.recordSuccess("admin", "203.0.113.8", now);
    expect(throttle.check("admin", "203.0.113.8", now)).toBe(true);
  });

  it("fails closed for high-cardinality overflow without evicting an active lockout", () => {
    const throttle = createLoginThrottle({ maxEntries: 3 });
    const now = new Date("2026-08-18T10:00:00.000Z");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      throttle.recordFailure("admin", "203.0.113.8", now);
    }
    throttle.recordFailure("noise-1", "203.0.113.9", now);
    throttle.recordFailure("noise-2", "203.0.113.10", now);

    for (let key = 0; key < 50; key += 1) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        throttle.recordFailure(`overflow-${key}`, `198.51.100.${key}`, now);
      }
      expect(throttle.check(`overflow-${key}`, `198.51.100.${key}`, now)).toBe(false);
    }
    expect(throttle.check("noise-1", "203.0.113.9", now)).toBe(true);
    expect(throttle.check("admin", "203.0.113.8", now)).toBe(false);
  });

  it("reclaims stale entries across the whole map before applying capacity", () => {
    const throttle = createLoginThrottle({ maxEntries: 64 });
    const initial = new Date("2026-08-18T10:00:00.000Z");

    for (let key = 0; key < 64; key += 1) {
      throttle.recordFailure(`stale-${key}`, `198.51.100.${key}`, initial);
    }
    expect(throttle.check("admin", "203.0.113.8", initial)).toBe(false);

    const afterWindow = new Date(initial.getTime() + 15 * 60 * 1000 + 1);
    expect(throttle.check("admin", "203.0.113.8", afterWindow)).toBe(true);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      throttle.recordFailure("admin", "203.0.113.8", afterWindow);
    }

    expect(throttle.check("admin", "203.0.113.8", afterWindow)).toBe(false);
  });

  it("uses the same failure response for unknown, incorrect, and malformed credentials", async () => {
    const app = createWebApp(buildServices());

    for (const body of [
      { username: "unknown", password: "correct-password" },
      { username: "admin", password: "wrong-password" },
      { username: "admin" },
    ]) {
      const response = await login(app, body);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "invalid credentials" });
    }
  });

  it("adds Secure for HTTPS and clears the same cookie policy on logout", async () => {
    const app = createWebApp(buildServices({ secureCookies: true }));
    const loginResponse = await login(app);
    const cookie = loginResponse.headers.get("set-cookie") ?? "";

    expect(cookie).toContain("Secure");

    const logoutResponse = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: cookiePair(cookie) },
    });
    const clearedCookie = logoutResponse.headers.get("set-cookie") ?? "";

    expect(logoutResponse.status).toBe(204);
    expect(clearedCookie).toContain("triagepilot_session=");
    expect(clearedCookie).toContain("Max-Age=0");
    expect(clearedCookie).toContain("Path=/");
    expect(clearedCookie).toContain("HttpOnly");
    expect(clearedCookie).toContain("SameSite=Strict");
    expect(clearedCookie).toContain("Secure");
  });

  it("uses the session cookie for auth and operations while rejecting bearer access", async () => {
    const app = createWebApp(buildServices());
    const loginResponse = await login(app);
    const cookie = cookiePair(loginResponse.headers.get("set-cookie") ?? "");

    const sessionResponse = await app.request("/api/auth/session", { headers: { cookie } });
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toEqual({ authenticated: true, username: "admin" });

    expect((await app.request("/api/operations/overview", { headers: { cookie } })).status).toBe(200);
    expect(
      (
        await app.request("/api/operations/overview", {
          headers: { authorization: "Bearer setup-token" },
        })
      ).status,
    ).toBe(401);
  });

  it("removes setup routes", async () => {
    const app = createWebApp(buildServices());

    expect((await app.request("/api/setup/status", { headers: { authorization: "Bearer setup-token" } })).status).toBe(404);
  });
});

async function login(
  app: ReturnType<typeof createWebApp>,
  body: Record<string, string> = loginBody,
): Promise<Response> {
  return await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

function nonCanonicalBase64UrlAlias(segment: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalIndex = alphabet.indexOf(segment.at(-1) ?? "");
  const unusedBits = segment.length % 4 === 2 ? 4 : segment.length % 4 === 3 ? 2 : 0;
  if (finalIndex < 0 || unusedBits === 0 || finalIndex % 2 ** unusedBits !== 0) {
    throw new Error("segment has no canonical unpadded alias");
  }
  return `${segment.slice(0, -1)}${alphabet[finalIndex + 1]}`;
}
