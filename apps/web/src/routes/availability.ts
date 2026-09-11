import {
  ProviderConnectionUnavailableError,
  ReviewerAbsenceConflictError,
  ReviewerAbsenceRevisionError,
  ReviewerAvailabilityValidationError,
} from "@triagepilot/db";
import type {
  AvailabilitySettingsOverview,
  ReviewerAbsenceOverview,
  ReviewerReplacementOverview,
} from "@triagepilot/ui";
import { Hono, type Context, type MiddlewareHandler } from "hono";

import {
  AvailabilityInputError,
  parseAvailabilityBody,
  parseAvailabilityMutation,
  parseCancellationInput,
  parseTimezoneInput,
} from "../availability-input";
import { requireAdminSession, type AdminSessionServices } from "./auth";

export interface AvailabilityServices extends AdminSessionServices {
  readAvailabilitySettings(): Promise<AvailabilitySettingsOverview>;
  updateAvailabilityTimezone(input: { timezone: string; now: Date }): Promise<AvailabilitySettingsOverview>;
  listReviewerAbsences(): Promise<ReviewerAbsenceOverview[]>;
  scheduleReviewerAbsence(input: {
    externalActorId: string; startAt: Date; endAt: Date; now: Date;
  }): Promise<ReviewerAbsenceOverview>;
  reviseReviewerAbsence(input: {
    absenceId: string; expectedRevision: number; externalActorId: string; startAt: Date; endAt: Date; now: Date;
  }): Promise<ReviewerAbsenceOverview>;
  cancelReviewerAbsence(input: {
    absenceId: string; expectedRevision: number; now: Date;
  }): Promise<ReviewerAbsenceOverview>;
  listReviewerReplacementHistory(absenceId?: string): Promise<ReviewerReplacementOverview[]>;
}

export function availabilityRoutes(services: AvailabilityServices) {
  const app = new Hono();
  const guards = [requireAdminSession(services), requireBoundWorkspace(services)] as const;

  app.get("/timezone", ...guards, async (c) => handleAvailabilityError(c, async () => c.json(await services.readAvailabilitySettings())));
  app.put("/timezone", ...guards, async (c) => handleAvailabilityError(c, async () => {
    const timezone = parseTimezoneInput(await readJson(c));
    return c.json(await services.updateAvailabilityTimezone({ timezone, now: services.now() }));
  }));
  app.get("/absences", ...guards, async (c) => handleAvailabilityError(c, async () => c.json(await services.listReviewerAbsences())));
  app.post("/absences", ...guards, async (c) => handleAvailabilityError(c, async () => {
    const now = services.now();
    const settings = await services.readAvailabilitySettings();
    const parsed = parseAvailabilityMutation({ ...parseAvailabilityBody(await readJson(c)), timezone: settings.timezone });
    return c.json(await services.scheduleReviewerAbsence({ ...parsed, now }), 201);
  }));
  app.put("/absences/:id", ...guards, async (c) => handleAvailabilityError(c, async () => {
    const now = services.now();
    const settings = await services.readAvailabilitySettings();
    const parsed = parseAvailabilityMutation({ ...parseAvailabilityBody(await readJson(c)), timezone: settings.timezone });
    if (parsed.expectedRevision === undefined) {
      throw new AvailabilityInputError([{ field: "expectedRevision", message: "Expected revision is required." }]);
    }
    return c.json(await services.reviseReviewerAbsence({
      absenceId: c.req.param("id"), ...parsed, expectedRevision: parsed.expectedRevision, now,
    }));
  }));
  app.post("/absences/:id/cancel", ...guards, async (c) => handleAvailabilityError(c, async () => {
    const { expectedRevision } = parseCancellationInput(await readJson(c));
    return c.json(await services.cancelReviewerAbsence({
      absenceId: c.req.param("id"), expectedRevision, now: services.now(),
    }));
  }));
  app.get("/replacements", ...guards, async (c) => handleAvailabilityError(c, async () => {
    const absenceId = c.req.query("absenceId")?.trim();
    return c.json(await services.listReviewerReplacementHistory(absenceId || undefined));
  }));
  return app;
}

function requireBoundWorkspace(services: AvailabilityServices): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header("x-triagepilot-workspace") !== services.workspaceId) {
      return c.json({ error: "workspace_scope_mismatch" }, 403);
    }
    await next();
  };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AvailabilityInputError([{ field: "body", message: "Expected a JSON object." }]);
  }
}

async function handleAvailabilityError(c: Context, action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AvailabilityInputError) return c.json({ error: "validation_failed", issues: error.issues }, 422);
    if (error instanceof ReviewerAvailabilityValidationError) {
      return c.json({ error: "validation_failed", issues: [{ field: "body", message: error.message }] }, 422);
    }
    if (error instanceof ReviewerAbsenceConflictError) return c.json({ error: "conflict", message: error.message }, 422);
    if (error instanceof ReviewerAbsenceRevisionError) return c.json({ error: "revision_conflict", message: error.message }, 409);
    if (error instanceof ProviderConnectionUnavailableError) {
      return c.json({ error: "availability_unavailable", message: "Reviewer availability is unavailable." }, 404);
    }
    throw error;
  }
}
