import {
  ProviderConnectionUnavailableError,
  ReviewerAbsenceConflictError,
  ReviewerAbsenceRevisionError,
} from "@triagepilot/db";
import { describe, expect, it, vi } from "vitest";

import { createWebApp } from "../src/app";
import { buildServices } from "./helpers";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const scopeHeaders = { "x-triagepilot-workspace": workspaceId };

describe("workspace reviewer availability routes", () => {
  it.each([
    ["GET", "/api/operations/availability/timezone"],
    ["PUT", "/api/operations/availability/timezone"],
    ["GET", "/api/operations/availability/absences"],
    ["POST", "/api/operations/availability/absences"],
    ["PUT", "/api/operations/availability/absences/absence-1"],
    ["POST", "/api/operations/availability/absences/absence-1/cancel"],
    ["GET", "/api/operations/availability/replacements"],
  ] as const)("requires an administrator session for %s %s", async (method, path) => {
    const response = await createWebApp(buildServices()).request(path, {
      method,
      headers: { ...scopeHeaders, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a workspace header outside the authenticated self-hosted workspace", async () => {
    const { app, cookie } = await authenticatedApp();
    const response = await app.request("/api/operations/availability/absences", {
      headers: { cookie, "x-triagepilot-workspace": "00000000-0000-4000-8000-000000000002" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "workspace_scope_mismatch" });
  });

  it("reads timezone, absences, and scoped replacement history", async () => {
    const { app, cookie } = await authenticatedApp({
      readAvailabilitySettings: async () => settings,
      listReviewerAbsences: async () => [absence],
      listReviewerReplacementHistory: async () => [replacement],
    });
    const headers = { cookie, ...scopeHeaders };
    expect(await (await app.request("/api/operations/availability/timezone", { headers })).json()).toEqual(settings);
    expect(await (await app.request("/api/operations/availability/absences", { headers })).json()).toEqual([absence]);
    expect(await (await app.request("/api/operations/availability/replacements?absenceId=absence-1", { headers })).json())
      .toEqual([replacement]);
  });

  it("updates timezone and schedules, revises, and cancels with parsed instants and revisions", async () => {
    const updateAvailabilityTimezone = vi.fn(async () => settings);
    const scheduleReviewerAbsence = vi.fn(async () => absence);
    const reviseReviewerAbsence = vi.fn(async () => ({ ...absence, revision: 2 }));
    const cancelReviewerAbsence = vi.fn(async () => ({ ...absence, status: "cancelled" as const, revision: 3 }));
    const { app, cookie } = await authenticatedApp({
      readAvailabilitySettings: async () => settings,
      updateAvailabilityTimezone,
      scheduleReviewerAbsence,
      reviseReviewerAbsence,
      cancelReviewerAbsence,
    });
    const headers = { cookie, ...scopeHeaders, "content-type": "application/json" };
    const body = JSON.stringify({
      externalActorId: " @User-D82A5F ",
      startLocal: "2026-03-28T09:00",
      endLocal: "2026-03-28T17:00",
    });

    expect((await app.request("/api/operations/availability/timezone", {
      method: "PUT", headers, body: JSON.stringify({ timezone: "Europe/Bratislava" }),
    })).status).toBe(200);
    expect((await app.request("/api/operations/availability/absences", { method: "POST", headers, body })).status).toBe(201);
    expect((await app.request("/api/operations/availability/absences/absence-1", {
      method: "PUT", headers, body: JSON.stringify({ ...JSON.parse(body), expectedRevision: 1 }),
    })).status).toBe(200);
    expect((await app.request("/api/operations/availability/absences/absence-1/cancel", {
      method: "POST", headers, body: JSON.stringify({ expectedRevision: 2 }),
    })).status).toBe(200);

    expect(updateAvailabilityTimezone).toHaveBeenCalledWith({ timezone: "Europe/Bratislava", now: fixedNow });
    expect(scheduleReviewerAbsence).toHaveBeenCalledWith({
      externalActorId: "@user-d82a5f",
      startAt: new Date("2026-03-28T08:00:00.000Z"),
      endAt: new Date("2026-03-28T16:00:00.000Z"),
      now: fixedNow,
    });
    expect(reviseReviewerAbsence).toHaveBeenCalledWith(expect.objectContaining({ absenceId: "absence-1", expectedRevision: 1 }));
    expect(cancelReviewerAbsence).toHaveBeenCalledWith({ absenceId: "absence-1", expectedRevision: 2, now: fixedNow });
  });

  it("maps validation, overlap, revision, and inactive-connection errors without leaking scope", async () => {
    const headersFor = (cookie: string) => ({ cookie, ...scopeHeaders, "content-type": "application/json" });
    const body = JSON.stringify({ externalActorId: "@user-d82a5f", startLocal: "2026-03-28T09:00", endLocal: "2026-03-28T17:00" });
    for (const [error, status, code] of [
      [new ReviewerAbsenceConflictError("overlap"), 422, "conflict"],
      [new ReviewerAbsenceRevisionError("stale"), 409, "revision_conflict"],
      [new ProviderConnectionUnavailableError("inactive"), 404, "availability_unavailable"],
    ] as const) {
      const { app, cookie } = await authenticatedApp({ scheduleReviewerAbsence: async () => { throw error; } });
      const response = await app.request("/api/operations/availability/absences", {
        method: "POST", headers: headersFor(cookie), body,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: code });
    }
    const { app, cookie } = await authenticatedApp();
    const invalid = await app.request("/api/operations/availability/absences", {
      method: "POST",
      headers: headersFor(cookie),
      body: JSON.stringify({ externalActorId: "@user-d82a5f", startLocal: "2026-03-28T09:00", endLocal: "2026-03-28T09:00" }),
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({
      error: "validation_failed",
      issues: [{ field: "endLocal", message: "End must be strictly after start." }],
    });
  });
});

const fixedNow = new Date("2026-08-18T10:00:00.000Z");
const settings = { timezone: "Europe/Bratislava", updatedAt: fixedNow.toISOString() };
const absence = {
  id: "absence-1", externalActorId: "@user-d82a5f", startAt: "2026-09-01T06:00:00.000Z",
  endAt: "2026-09-01T15:00:00.000Z", status: "upcoming" as const, revision: 1, cancelledAt: null,
  createdAt: fixedNow.toISOString(), updatedAt: fixedNow.toISOString(),
};
const replacement = {
  id: "replacement-1", absenceId: "absence-1", absenceRevision: 1, decisionId: "decision-1",
  unavailableActorId: "@user-d82a5f", replacementActorId: "@user-c91e46", outcome: "replaced" as const,
  reason: "reviewer absence", state: "completed" as const, lastError: null, completedAt: fixedNow.toISOString(),
};

async function authenticatedApp(overrides: Parameters<typeof buildServices>[0] = {}) {
  const app = createWebApp(buildServices(overrides));
  const response = await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "correct-password" }),
  });
  return { app, cookie: (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "" };
}
