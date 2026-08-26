import {
  ReviewerAbsenceConflictError,
  ReviewerAbsenceNotFoundError,
  ReviewerAbsenceRevisionError,
  ReviewerAbsenceValidationError,
  type AvailabilityOverview,
} from "@triagepilot/db";
import { Hono, type Context } from "hono";

import {
  AvailabilityInputError,
  parseAbsenceBody,
  parseCancellationInput,
  parseLocalAbsenceInput,
  parseTimezoneInput,
} from "../availability-input";
import { requireAdminSession, type AdminSessionServices } from "./auth";

export interface AvailabilityServices extends AdminSessionServices {
  readAvailabilityOverview(input: { now: Date }): Promise<AvailabilityOverview>;
  updateOrganizationTimezone(input: { timezone: string; now: Date }): Promise<void>;
  createReviewerAbsence(input: {
    reviewerHandle: string;
    startAt: Date;
    endAt: Date;
    now: Date;
  }): Promise<unknown>;
  updateReviewerAbsence(input: {
    absenceId: string;
    expectedRevision: number;
    reviewerHandle: string;
    startAt: Date;
    endAt: Date;
    now: Date;
  }): Promise<unknown>;
  cancelReviewerAbsence(input: { absenceId: string; expectedRevision: number; now: Date }): Promise<unknown>;
}

export function availabilityRoutes(services: AvailabilityServices) {
  const app = new Hono();
  const requireAdmin = requireAdminSession(services);

  app.get("/", requireAdmin, async (c) => {
    const now = services.now();
    return c.json(await services.readAvailabilityOverview({ now }));
  });

  app.put("/timezone", requireAdmin, async (c) =>
    handleAvailabilityError(c, async () => {
      const now = services.now();
      const timezone = parseTimezoneInput(await readJson(c));
      await services.updateOrganizationTimezone({ timezone, now });
      return c.json(await services.readAvailabilityOverview({ now }));
    }),
  );

  app.post("/absences", requireAdmin, async (c) =>
    handleAvailabilityError(c, async () => {
      const now = services.now();
      const current = await services.readAvailabilityOverview({ now });
      const absence = parseLocalAbsenceInput({ ...parseAbsenceBody(await readJson(c)), timezone: current.timezone });
      await services.createReviewerAbsence({
        reviewerHandle: absence.reviewerHandle,
        startAt: absence.startAt,
        endAt: absence.endAt,
        now,
      });
      return c.json(await services.readAvailabilityOverview({ now }));
    }),
  );

  app.put("/absences/:id", requireAdmin, async (c) =>
    handleAvailabilityError(c, async () => {
      const now = services.now();
      const current = await services.readAvailabilityOverview({ now });
      const absence = parseLocalAbsenceInput({ ...parseAbsenceBody(await readJson(c)), timezone: current.timezone });
      if (absence.expectedRevision === undefined) {
        throw new AvailabilityInputError([{ field: "expectedRevision", message: "Expected revision is required." }]);
      }
      await services.updateReviewerAbsence({
        absenceId: c.req.param("id"),
        expectedRevision: absence.expectedRevision,
        reviewerHandle: absence.reviewerHandle,
        startAt: absence.startAt,
        endAt: absence.endAt,
        now,
      });
      return c.json(await services.readAvailabilityOverview({ now }));
    }),
  );

  app.post("/absences/:id/cancel", requireAdmin, async (c) =>
    handleAvailabilityError(c, async () => {
      const now = services.now();
      const cancellation = parseCancellationInput(await readJson(c));
      await services.cancelReviewerAbsence({
        absenceId: c.req.param("id"),
        expectedRevision: cancellation.expectedRevision,
        now,
      });
      return c.json(await services.readAvailabilityOverview({ now }));
    }),
  );

  return app;
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
    if (error instanceof AvailabilityInputError) {
      return c.json({ error: "validation_failed", issues: error.issues }, 422);
    }
    if (error instanceof ReviewerAbsenceValidationError) {
      return c.json({
        error: "validation_failed",
        issues: [{ field: "body", message: error.message }],
      }, 422);
    }
    if (error instanceof ReviewerAbsenceConflictError) {
      return c.json({ error: "conflict", message: error.message }, 422);
    }
    if (error instanceof ReviewerAbsenceNotFoundError) {
      return c.json({ error: "not_found", message: error.message }, 404);
    }
    if (error instanceof ReviewerAbsenceRevisionError) {
      return c.json({ error: "revision_conflict", message: error.message }, 409);
    }
    throw error;
  }
}
