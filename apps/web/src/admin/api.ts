import type { OperationsOverview } from "@triagepilot/db";

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

export type { OperationsOverview };
