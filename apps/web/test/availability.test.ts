import {
  ReviewerAbsenceConflictError,
  ReviewerAbsenceNotFoundError,
  ReviewerAbsenceRevisionError,
} from "@triagepilot/db";
import { describe, expect, it, vi } from "vitest";

import { createWebApp } from "../src/app";
import { buildServices } from "./helpers";

const overview = { timezone: "Europe/Bratislava", absences: [] };

describe("availability routes", () => {
  it.each([
    ["GET", "/api/operations/availability"],
    ["PUT", "/api/operations/availability/timezone"],
    ["POST", "/api/operations/availability/absences"],
    ["PUT", "/api/operations/availability/absences/absence-1"],
    ["POST", "/api/operations/availability/absences/absence-1/cancel"],
  ] as const)("requires an administrator session for %s %s", async (method, path) => {
    const app = createWebApp(buildServices());

    const response = await app.request(path, method === "GET" ? { method } : {
      method,
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("returns the default UTC overview to an authenticated administrator", async () => {
    const { app, cookie } = await authenticatedApp({
      readAvailabilityOverview: async () => ({ timezone: "UTC", absences: [] }),
    });

    const response = await app.request("/api/operations/availability", { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ timezone: "UTC", absences: [] });
  });

  it("updates timezone and returns the persisted availability overview", async () => {
    const updateOrganizationTimezone = vi.fn().mockResolvedValue(undefined);
    const { app, cookie } = await authenticatedApp({
      updateOrganizationTimezone,
      readAvailabilityOverview: async () => overview,
    });

    const response = await app.request("/api/operations/availability/timezone", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ timezone: "America/New_York" }),
    });

    expect(response.status).toBe(200);
    expect(updateOrganizationTimezone).toHaveBeenCalledWith({
      timezone: "America/New_York",
      now: new Date("2026-08-18T10:00:00.000Z"),
    });
    expect(await response.json()).toEqual(overview);
  });

  it("creates an absence from the persisted timezone and returns the current overview", async () => {
    const createReviewerAbsence = vi.fn().mockResolvedValue(undefined);
    const { app, cookie } = await authenticatedApp({
      createReviewerAbsence,
      readAvailabilityOverview: vi.fn()
        .mockResolvedValueOnce({ timezone: "Europe/Bratislava", absences: [] })
        .mockResolvedValueOnce(overview),
    });

    const response = await app.request("/api/operations/availability/absences", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        reviewerHandle: "@User-D82A5F",
        startLocal: "2026-03-28T09:00",
        endLocal: "2026-03-28T17:00",
      }),
    });

    expect(response.status).toBe(200);
    expect(createReviewerAbsence).toHaveBeenCalledWith({
      reviewerHandle: "@user-d82a5f",
      startAt: new Date("2026-03-28T08:00:00.000Z"),
      endAt: new Date("2026-03-28T16:00:00.000Z"),
      now: new Date("2026-08-18T10:00:00.000Z"),
    });
    expect(await response.json()).toEqual(overview);
  });

  it("edits and cancels an absence with optimistic revision values", async () => {
    const updateReviewerAbsence = vi.fn().mockResolvedValue(undefined);
    const cancelReviewerAbsence = vi.fn().mockResolvedValue(undefined);
    const { app, cookie } = await authenticatedApp({
      updateReviewerAbsence,
      cancelReviewerAbsence,
      readAvailabilityOverview: vi.fn().mockResolvedValue({ timezone: "Europe/Bratislava", absences: [] }),
    });

    const updateResponse = await app.request("/api/operations/availability/absences/absence-1", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        reviewerHandle: "@User-D82A5F",
        startLocal: "2026-03-28T09:00",
        endLocal: "2026-03-28T17:00",
        expectedRevision: 3,
      }),
    });
    const cancelResponse = await app.request("/api/operations/availability/absences/absence-1/cancel", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 4 }),
    });

    expect(updateResponse.status).toBe(200);
    expect(updateReviewerAbsence).toHaveBeenCalledWith(expect.objectContaining({
      absenceId: "absence-1",
      expectedRevision: 3,
      startAt: new Date("2026-03-28T08:00:00.000Z"),
      endAt: new Date("2026-03-28T16:00:00.000Z"),
    }));
    expect(cancelResponse.status).toBe(200);
    expect(cancelReviewerAbsence).toHaveBeenCalledWith({
      absenceId: "absence-1",
      expectedRevision: 4,
      now: new Date("2026-08-18T10:00:00.000Z"),
    });
  });

  it("returns validation and conflict errors as 422", async () => {
    const { app, cookie } = await authenticatedApp({
      createReviewerAbsence: async () => {
        throw new ReviewerAbsenceConflictError("Reviewer absence overlaps an existing absence");
      },
      readAvailabilityOverview: async () => ({ timezone: "Europe/Bratislava", absences: [] }),
    });

    const invalid = await app.request("/api/operations/availability/absences", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        reviewerHandle: "@user-d82a5f",
        startLocal: "2026-03-28T09:00",
        endLocal: "2026-03-28T09:00",
      }),
    });
    const conflict = await app.request("/api/operations/availability/absences", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        reviewerHandle: "@user-d82a5f",
        startLocal: "2026-03-28T09:00",
        endLocal: "2026-03-28T17:00",
      }),
    });

    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({
      error: "validation_failed",
      issues: [{ field: "endLocal", message: "End must be strictly after start." }],
    });
    expect(conflict.status).toBe(422);
    expect(await conflict.json()).toEqual({ error: "conflict", message: "Reviewer absence overlaps an existing absence" });
  });

  it("rejects unexpected absence request fields", async () => {
    const { app, cookie } = await authenticatedApp({
      readAvailabilityOverview: async () => ({ timezone: "Europe/Bratislava", absences: [] }),
    });

    const response = await app.request("/api/operations/availability/absences", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        reviewerHandle: "@user-d82a5f",
        startLocal: "2026-03-28T09:00",
        endLocal: "2026-03-28T17:00",
        timezone: "UTC",
      }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "validation_failed",
      issues: [{ field: "timezone", message: "Unexpected field." }],
    });
  });

  it("maps unknown absence and stale revisions to 404 and 409", async () => {
    const { app, cookie } = await authenticatedApp({
      cancelReviewerAbsence: async () => {
        throw new ReviewerAbsenceNotFoundError("Reviewer absence was not found");
      },
      updateReviewerAbsence: async () => {
        throw new ReviewerAbsenceRevisionError("Reviewer absence revision is stale");
      },
      readAvailabilityOverview: async () => ({ timezone: "Europe/Bratislava", absences: [] }),
    });

    const missing = await app.request("/api/operations/availability/absences/missing/cancel", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    const stale = await app.request("/api/operations/availability/absences/absence-1", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        reviewerHandle: "@user-d82a5f",
        startLocal: "2026-03-28T09:00",
        endLocal: "2026-03-28T17:00",
        expectedRevision: 1,
      }),
    });

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found", message: "Reviewer absence was not found" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "revision_conflict", message: "Reviewer absence revision is stale" });
  });
});

async function authenticatedApp(overrides: Parameters<typeof buildServices>[0]) {
  const app = createWebApp(buildServices(overrides));
  const loginResponse = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "correct-password" }),
  });
  return {
    app,
    cookie: (loginResponse.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "",
  };
}
