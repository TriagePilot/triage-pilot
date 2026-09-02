import { z, type ZodError } from "zod";

export interface AvailabilityInputIssue {
  field: string;
  message: string;
}

export class AvailabilityInputError extends Error {
  constructor(readonly issues: AvailabilityInputIssue[]) {
    super("Availability input validation failed");
  }
}

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, {
  message: "Enter a local date and time in YYYY-MM-DDTHH:mm.",
});
const utcOffset = z.string().regex(/^[+-](?:0\d|1[0-4]):[0-5]\d$/, {
  message: "Enter a UTC offset such as +02:00.",
});
const absenceBodySchema = z.object({
  externalActorId: z.string(),
  startLocal: localDateTime,
  endLocal: localDateTime,
  startUtcOffset: utcOffset.optional(),
  endUtcOffset: utcOffset.optional(),
  expectedRevision: z.number().int().positive().optional(),
}).strict();
const timezoneSchema = z.object({ timezone: z.string().min(1) }).strict();
const cancellationSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
const canonicalTimezones = new Set(Intl.supportedValuesOf("timeZone"));

export type AvailabilityMutationBody = z.infer<typeof absenceBodySchema>;

export function parseAvailabilityBody(input: unknown): AvailabilityMutationBody {
  return parseSchema(absenceBodySchema, input);
}

export function parseTimezoneInput(input: unknown): string {
  const { timezone } = parseSchema(timezoneSchema, input);
  if (!isValidTimezone(timezone)) {
    throw new AvailabilityInputError([{ field: "timezone", message: "Enter a valid IANA timezone." }]);
  }
  return timezone;
}

export function parseCancellationInput(input: unknown): { expectedRevision: number } {
  return parseSchema(cancellationSchema, input);
}

export function parseAvailabilityMutation(input: unknown): {
  externalActorId: string;
  startAt: Date;
  endAt: Date;
  expectedRevision?: number;
} {
  const value = parseSchema(absenceBodySchema.extend({ timezone: z.string().min(1) }).strict(), input);
  const issues: AvailabilityInputIssue[] = [];
  const externalActorId = value.externalActorId.trim().toLowerCase();
  if (externalActorId === "") issues.push({ field: "externalActorId", message: "External actor identifier is required." });
  if (!isValidTimezone(value.timezone)) issues.push({ field: "timezone", message: "Enter a valid IANA timezone." });

  const startAt = isValidTimezone(value.timezone)
    ? resolveLocalInstant(value.startLocal, value.timezone, value.startUtcOffset, "startLocal", "startUtcOffset", issues)
    : undefined;
  const endAt = isValidTimezone(value.timezone)
    ? resolveLocalInstant(value.endLocal, value.timezone, value.endUtcOffset, "endLocal", "endUtcOffset", issues)
    : undefined;
  if (startAt && endAt && endAt <= startAt) {
    issues.push({ field: "endLocal", message: "End must be strictly after start." });
  }
  if (issues.length > 0 || externalActorId === "" || !startAt || !endAt) throw new AvailabilityInputError(issues);
  return value.expectedRevision === undefined
    ? { externalActorId, startAt, endAt }
    : { externalActorId, startAt, endAt, expectedRevision: value.expectedRevision };
}

function resolveLocalInstant(
  local: string,
  timezone: string,
  offset: string | undefined,
  localField: string,
  offsetField: string,
  issues: AvailabilityInputIssue[],
): Date | undefined {
  const components = parseComponents(local);
  if (!components) {
    issues.push({ field: localField, message: "This local time does not exist in the selected timezone." });
    return undefined;
  }
  const possible = possibleInstants(components, timezone);
  if (possible.length === 0) {
    issues.push({ field: localField, message: "This local time does not exist in the selected timezone." });
    return undefined;
  }
  if (offset === undefined) {
    if (possible.length > 1) {
      issues.push({ field: offsetField, message: "Choose the UTC offset for this ambiguous local time." });
      return undefined;
    }
    return possible[0]?.instant;
  }
  const offsetMinutes = parseOffset(offset);
  const selected = possible.find((candidate) => candidate.offsetMinutes === offsetMinutes);
  if (!selected) {
    issues.push({ field: offsetField, message: "The UTC offset does not match this local time." });
    return undefined;
  }
  return selected.instant;
}

interface LocalComponents { year: number; month: number; day: number; hour: number; minute: number }

function parseComponents(value: string): LocalComponents | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const components = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]),
  };
  const normalized = new Date(Date.UTC(
    components.year, components.month - 1, components.day, components.hour, components.minute,
  ));
  return normalized.getUTCFullYear() === components.year
    && normalized.getUTCMonth() + 1 === components.month
    && normalized.getUTCDate() === components.day
    && normalized.getUTCHours() === components.hour
    && normalized.getUTCMinutes() === components.minute
    ? components
    : null;
}

function possibleInstants(components: LocalComponents, timezone: string) {
  const localEpoch = Date.UTC(components.year, components.month - 1, components.day, components.hour, components.minute);
  const offsets = new Set<number>();
  for (const delta of [-172_800_000, -86_400_000, 0, 86_400_000, 172_800_000]) {
    offsets.add(offsetAt(localEpoch + delta, timezone));
  }
  return [...offsets].map((offsetMinutes) => ({
    offsetMinutes,
    instant: new Date(localEpoch - offsetMinutes * 60_000),
  })).filter(({ instant }) => equalComponents(formatComponents(instant, timezone), components))
    .sort((left, right) => left.instant.getTime() - right.instant.getTime());
}

function offsetAt(epoch: number, timezone: string): number {
  const instant = new Date(Math.floor(epoch / 60_000) * 60_000);
  const local = formatComponents(instant, timezone);
  return (Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - instant.getTime()) / 60_000;
}

function formatComponents(value: Date, timezone: string): LocalComponents {
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return fields as unknown as LocalComponents;
}

function equalComponents(left: LocalComponents, right: LocalComponents): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

function parseOffset(value: string): number {
  const sign = value.startsWith("-") ? -1 : 1;
  const [hours = 0, minutes = 0] = value.slice(1).split(":").map(Number);
  return sign * (hours * 60 + minutes);
}

function isValidTimezone(value: string): boolean {
  return value === "UTC" || canonicalTimezones.has(value);
}

function parseSchema<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AvailabilityInputError(toIssues(result.error));
}

function toIssues(error: ZodError): AvailabilityInputIssue[] {
  return error.issues.flatMap((issue) => issue.code === "unrecognized_keys"
    ? issue.keys.map((key) => ({ field: key, message: "Unexpected field." }))
    : [{ field: issue.path.join(".") || "body", message: issue.message }]);
}
