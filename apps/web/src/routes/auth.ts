import { createHash, timingSafeEqual } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono, type Context, type MiddlewareHandler } from "hono";

import { createLoginThrottle } from "../auth/login-throttle";
import {
  createSessionToken,
  SESSION_COOKIE,
  sessionCookieOptions,
  verifySessionToken,
} from "../auth/session";

export interface AdminSessionServices {
  adminUsername: string;
  sessionSecret: string;
  now(): Date;
}

export interface AuthServices extends AdminSessionServices {
  adminPassword: string;
  secureCookies: boolean;
  sourceAddress(c: Context): string;
}

export function authRoutes(services: AuthServices) {
  const app = new Hono();
  const throttle = createLoginThrottle();

  app.post("/login", async (c) => {
    const input = await readCredentials(c);
    const username = input?.username ?? "";
    const password = input?.password ?? "";
    const now = services.now();
    const sourceAddress = services.sourceAddress(c);
    const allowed = throttle.check(username, sourceAddress, now);
    const usernameMatches = constantTimeEqual(username, services.adminUsername);
    const passwordMatches = constantTimeEqual(password, services.adminPassword);

    if (!allowed || !input || !usernameMatches || !passwordMatches) {
      if (allowed) throttle.recordFailure(username, sourceAddress, now);
      return c.json({ error: "invalid credentials" }, 401);
    }

    throttle.recordSuccess(username, sourceAddress, now);
    setCookie(
      c,
      SESSION_COOKIE,
      createSessionToken({ username: services.adminUsername, now, secret: services.sessionSecret }),
      sessionCookieOptions(services.secureCookies),
    );
    return c.body(null, 204);
  });

  app.get("/session", requireAdminSession(services), (c) =>
    c.json({ authenticated: true, username: services.adminUsername }),
  );

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, sessionCookieOptions(services.secureCookies));
    return c.body(null, 204);
  });

  return app;
}

export function requireAdminSession(services: AdminSessionServices): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (
      !token ||
      !verifySessionToken({
        token,
        username: services.adminUsername,
        now: services.now(),
        secret: services.sessionSecret,
      })
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

async function readCredentials(c: Context): Promise<{ username: string; password: string } | null> {
  try {
    const value = (await c.req.json()) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("username" in value) ||
      typeof value.username !== "string" ||
      !("password" in value) ||
      typeof value.password !== "string"
    ) {
      return null;
    }
    return { username: value.username, password: value.password };
  } catch {
    return null;
  }
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
