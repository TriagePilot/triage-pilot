import type {
  EffectiveConfigurationOverview,
  OperationsApiClient,
  OperationsOverview,
  WorkspaceContext,
} from "@triagepilot/ui";

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

export function createSelfHostedOperationsApi(input: {
  onUnauthorized?(message: string): void;
} = {}): OperationsApiClient {
  return {
    async readOperationsOverview(workspace) {
      try {
        return await fetchOperationsOverviewForWorkspace(workspace);
      } catch (caught) {
        notifyUnauthorized(caught, input.onUnauthorized);
        throw caught;
      }
    },
    async readEffectiveConfiguration(workspace) {
      try {
        return await fetchEffectiveConfigurationForWorkspace(workspace);
      } catch (caught) {
        notifyUnauthorized(caught, input.onUnauthorized);
        throw caught;
      }
    },
  };
}

export async function fetchOperationsOverviewForWorkspace(
  workspace: WorkspaceContext,
): Promise<OperationsOverview> {
  const response = await fetch("/api/operations/overview", {
    credentials: "same-origin",
    headers: workspaceHeaders(workspace),
  });
  if (response.status === 401) {
    throw new AdminApiError("The administrator session has expired.", response.status);
  }
  if (!response.ok) {
    throw new AdminApiError("Could not load the operations overview.", response.status);
  }
  return response.json() as Promise<OperationsOverview>;
}

export async function fetchEffectiveConfigurationForWorkspace(
  workspace: WorkspaceContext,
): Promise<EffectiveConfigurationOverview> {
  const response = await fetch("/api/operations/effective-configuration", {
    credentials: "same-origin",
    headers: workspaceHeaders(workspace),
  });
  if (response.status === 401) {
    throw new AdminApiError("The administrator session has expired.", response.status);
  }
  if (!response.ok) {
    throw new AdminApiError("Could not load the effective configuration.", response.status);
  }
  return response.json() as Promise<EffectiveConfigurationOverview>;
}

function notifyUnauthorized(caught: unknown, onUnauthorized: ((message: string) => void) | undefined) {
  if (caught instanceof AdminApiError && caught.status === 401) {
    onUnauthorized?.(caught.message);
  }
}

function workspaceHeaders(workspace: WorkspaceContext): HeadersInit {
  return { "x-triagepilot-workspace": workspace.id };
}

export type { EffectiveConfigurationOverview, OperationsOverview };
