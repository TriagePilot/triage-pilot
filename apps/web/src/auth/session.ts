import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

export const SESSION_COOKIE = "triagepilot_session";

interface SessionTokenInput {
  username: string;
  now: Date;
  secret: string;
}

interface VerifySessionTokenInput extends SessionTokenInput {
  token: string;
}

interface SessionPayload {
  username: string;
  expiresAt: number;
}

export function createSessionToken({ username, now, secret }: SessionTokenInput): string {
  const payload = Buffer.from(
    JSON.stringify({ username, expiresAt: now.getTime() + SESSION_DURATION_MS } satisfies SessionPayload),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken({ token, username, now, secret }: VerifySessionTokenInput): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [encodedPayload, providedSignature] = parts;
    if (!encodedPayload || !providedSignature) return false;

    const payloadBytes = decodeCanonicalBase64Url(encodedPayload);
    const signature = decodeCanonicalBase64Url(providedSignature);
    if (!payloadBytes || !signature) return false;

    const expectedSignatureValue = sign(encodedPayload, secret);
    if (providedSignature.length !== expectedSignatureValue.length) return false;
    const expectedSignature = Buffer.from(expectedSignatureValue, "base64url");
    if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) return false;

    const payload = JSON.parse(payloadBytes.toString("utf8")) as unknown;
    if (!isSessionPayload(payload)) return false;
    return payload.username === username && payload.expiresAt > now.getTime();
  } catch {
    return false;
  }
}

export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "Strict" as const, secure, path: "/", maxAge: 43_200 };
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "username" in value &&
    typeof value.username === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt)
  );
}
