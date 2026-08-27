import type { AvailabilityOverview, OperationsOverview } from "@triagepilot/db";

export type AdminSession =
  | { authenticated: true; username: string }
  | { authenticated: false };

export class AdminApiError extends Error {
  readonly name = "AdminApiError";

  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function login(username: string, password: string): Promise<void> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new AdminApiError("Sign in failed. Check the administrator credentials.", response.status);
  }
}

export async function getSession(): Promise<AdminSession> {
  const response = await fetch("/api/auth/session", { credentials: "same-origin" });
  if (response.status === 401) return { authenticated: false };
  if (!response.ok) {
    throw new AdminApiError("Could not check the administrator session.", response.status);
  }
  return response.json() as Promise<AdminSession>;
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  if (!response.ok) throw new AdminApiError("Could not sign out.", response.status);
}

export async function fetchOperationsOverview(): Promise<OperationsOverview> {
  const response = await fetch("/api/operations/overview", { credentials: "same-origin" });
  if (response.status === 401) {
    throw new AdminApiError("The administrator session has expired.", response.status);
  }
  if (!response.ok) {
    throw new AdminApiError("Could not load the operations overview.", response.status);
  }
  return response.json() as Promise<OperationsOverview>;
}

export type RoutingRunRequest = { decisionId: string } | { pullRequestUrl: string };

export async function rerunRouting(request: RoutingRunRequest): Promise<{ status: "queued"; jobId: string }> {
  const response = await fetch("/api/operations/routing-runs", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.status === 401) {
    throw new AdminApiError("The administrator session has expired.", response.status);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    throw new AdminApiError(body?.message ?? "Could not queue the routing run.", response.status);
  }
  return response.json() as Promise<{ status: "queued"; jobId: string }>;
}

export interface AbsenceFormInput {
  reviewerHandle: string;
  startLocal: string;
  endLocal: string;
}

export async function fetchAvailability(): Promise<AvailabilityOverview> {
  return requestAvailability("");
}

export async function updateAvailabilityTimezone(timezone: string): Promise<AvailabilityOverview> {
  return requestAvailability("/timezone", {
    method: "PUT",
    body: JSON.stringify({ timezone }),
  });
}

export async function createAbsence(input: AbsenceFormInput): Promise<AvailabilityOverview> {
  return requestAvailability("/absences", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateAbsence(
  absenceId: string,
  input: AbsenceFormInput & { expectedRevision: number },
): Promise<AvailabilityOverview> {
  return requestAvailability(`/absences/${absenceId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function cancelAbsence(absenceId: string, expectedRevision: number): Promise<AvailabilityOverview> {
  return requestAvailability(`/absences/${absenceId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

async function requestAvailability(path: string, init: RequestInit = {}): Promise<AvailabilityOverview> {
  const response = await fetch(`/api/operations/availability${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (response.status === 401) {
    throw new AdminApiError("The administrator session has expired.", response.status);
  }
  if (response.status === 422) {
    const body = await response.json().catch(() => null) as { issues?: Array<{ message?: string }> } | null;
    throw new AdminApiError(body?.issues?.[0]?.message ?? "Could not update reviewer availability.", response.status);
  }
  if (!response.ok) {
    throw new AdminApiError("Could not update reviewer availability.", response.status);
  }
  return response.json() as Promise<AvailabilityOverview>;
}

export type { AvailabilityOverview, OperationsOverview };
