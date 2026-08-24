export class PermanentJobError extends Error {
  override readonly name = "PermanentJobError";
}

export class TransientJobError extends Error {
  override readonly name = "TransientJobError";
}

export class StaleJobLeaseError extends Error {
  override readonly name = "StaleJobLeaseError";
}

export function classifyWorkerError(error: unknown): PermanentJobError | TransientJobError {
  if (error instanceof PermanentJobError || error instanceof TransientJobError) return error;
  const message = error instanceof Error ? error.message : (readStringProperty(error, "message") ?? "worker job failed");
  const status = readNumericProperty(error, "status");
  if (status === 401 || status === 403 || status === 422) return new PermanentJobError(message);
  if (status === 429 || (status !== null && status >= 500 && status <= 599)) {
    return new TransientJobError(message);
  }
  if (isDatabaseError(error) || isNetworkError(error)) return new TransientJobError(message);
  return new TransientJobError(message);
}

function readNumericProperty(value: unknown, property: string): number | null {
  if (typeof value !== "object" || value === null || !(property in value)) return null;
  const candidate = value[property as keyof typeof value];
  return typeof candidate === "number" ? candidate : null;
}

function readStringProperty(value: unknown, property: string): string | null {
  if (typeof value !== "object" || value === null || !(property in value)) return null;
  const candidate = value[property as keyof typeof value];
  return typeof candidate === "string" ? candidate : null;
}

function isDatabaseError(error: unknown): boolean {
  return readStringProperty(error, "severity") !== null || readStringProperty(error, "name") === "DatabaseError";
}

function isNetworkError(error: unknown): boolean {
  const code = readStringProperty(error, "code");
  return code !== null && ["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ETIMEDOUT"].includes(code);
}
