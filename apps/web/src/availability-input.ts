import { Temporal } from "@js-temporal/polyfill";
import { normalizeReviewerHandle } from "@triagepilot/db";
import { z, type ZodError } from "zod";

export interface AvailabilityInputIssue {
  field: string;
  message: string;
}

export class AvailabilityInputError extends Error {
  constructor(public readonly issues: AvailabilityInputIssue[]) {
    super("Availability input validation failed");
  }
}

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, {
  message: "Enter a local date and time in YYYY-MM-DDTHH:mm.",
});

const absenceBodySchema = z.object({
  reviewerHandle: z.string(),
  startLocal: localDateTime,
  endLocal: localDateTime,
  expectedRevision: z.number().int().positive().optional(),
}).strict();

const absenceInputSchema = absenceBodySchema.extend({
  timezone: z.string().min(1),
}).strict();

const timezoneInputSchema = z.object({ timezone: z.string().min(1) }).strict();

const cancellationInputSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();

export type LocalAbsenceInput = z.infer<typeof absenceInputSchema>;

export function parseAbsenceBody(input: unknown): z.infer<typeof absenceBodySchema> {
  return parseSchema(absenceBodySchema, input);
}

export function parseTimezoneInput(input: unknown): string {
  const value = parseSchema(timezoneInputSchema, input);
  if (!isValidTimezone(value.timezone)) {
    throw new AvailabilityInputError([{ field: "timezone", message: "Enter a valid IANA timezone." }]);
  }
  return value.timezone;
}

export function parseLocalAbsenceInput(input: unknown): {
  reviewerHandle: string;
  startAt: Date;
  endAt: Date;
  expectedRevision?: number;
} {
  const value = parseSchema(absenceInputSchema, input);
  const issues: AvailabilityInputIssue[] = [];
  const reviewerHandle = normalizeReviewerHandle(value.reviewerHandle);
  if (!reviewerHandle) {
    issues.push({ field: "reviewerHandle", message: "Reviewer handle must be an individual GitHub handle." });
  }
  if (!isValidTimezone(value.timezone)) {
    issues.push({ field: "timezone", message: "Enter a valid IANA timezone." });
  }

  const startAt = isValidTimezone(value.timezone)
    ? parseLocalDateTime(value.startLocal, value.timezone, "startLocal", issues)
    : undefined;
  const endAt = isValidTimezone(value.timezone)
    ? parseLocalDateTime(value.endLocal, value.timezone, "endLocal", issues)
    : undefined;
  if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
    issues.push({ field: "endLocal", message: "End must be strictly after start." });
  }
  if (issues.length > 0 || !reviewerHandle || !startAt || !endAt) throw new AvailabilityInputError(issues);

  return value.expectedRevision === undefined
    ? { reviewerHandle, startAt, endAt }
    : { reviewerHandle, startAt, endAt, expectedRevision: value.expectedRevision };
}

export function parseCancellationInput(input: unknown): { expectedRevision: number } {
  return parseSchema(cancellationInputSchema, input);
}

function parseLocalDateTime(
  value: string,
  timezone: string,
  field: "startLocal" | "endLocal",
  issues: AvailabilityInputIssue[],
): Date | undefined {
  const [date = "", time = ""] = value.split("T");
  const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = date.split("-").map(Number);
  const [hour = Number.NaN, minute = Number.NaN] = time.split(":").map(Number);
  try {
    const instant = Temporal.ZonedDateTime.from(
      { timeZone: timezone, year, month, day, hour, minute },
      { disambiguation: "reject" },
    ).toInstant();
    return new Date(instant.epochMilliseconds);
  } catch {
    issues.push({ field, message: "Enter a valid, unambiguous local date and time." });
    return undefined;
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    Temporal.ZonedDateTime.from({ timeZone: timezone, year: 2000, month: 1, day: 1, hour: 0, minute: 0 });
    return true;
  } catch {
    return false;
  }
}

function parseSchema<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AvailabilityInputError(toIssues(result.error));
}

function toIssues(error: ZodError): AvailabilityInputIssue[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({ field: key, message: "Unexpected field." }));
    }
    return [{ field: issue.path.join(".") || "body", message: issue.message }];
  });
}
