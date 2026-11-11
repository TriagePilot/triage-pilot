import type {
  AnalyticsApiClient,
  PullRequestQueueApiClient,
  AvailabilitySettingsOverview,
  EffectiveConfigurationOverview,
  OperationsApiClient,
  OperationsOverview,
  ReviewerAbsenceMutation,
  ReviewerAbsenceOverview,
  ReviewerReplacementOverview,
  RepositoryContext,
  WorkspaceContext,
} from "@triagepilot/ui";

export type AdminSession =
  | { authenticated: true; username: string; workspaceId: string }
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
    async readEffectiveConfiguration(workspace, repository) {
      try {
        return await fetchEffectiveConfigurationForWorkspace(workspace, repository);
      } catch (caught) {
        notifyUnauthorized(caught, input.onUnauthorized);
        throw caught;
      }
    },
    async readAvailabilitySettings(workspace) {
      return withUnauthorized(input.onUnauthorized, () => requestAvailability<AvailabilitySettingsOverview>(workspace, "/timezone"));
    },
    async updateAvailabilityTimezone(workspace, timezone) {
      return withUnauthorized(input.onUnauthorized, () => requestAvailability<AvailabilitySettingsOverview>(workspace, "/timezone", {
        method: "PUT", body: JSON.stringify({ timezone }),
      }));
    },
    async listReviewerAbsences(workspace) {
      return withUnauthorized(input.onUnauthorized, () => requestAvailability<ReviewerAbsenceOverview[]>(workspace, "/absences"));
    },
    async scheduleReviewerAbsence(workspace, availability) {
      return withUnauthorized(input.onUnauthorized, () => requestAvailability<ReviewerAbsenceOverview>(workspace, "/absences", {
        method: "POST", body: JSON.stringify(availability),
      }));
    },
    async reviseReviewerAbsence(workspace, absenceId, availability) {
      return withUnauthorized(input.onUnauthorized, () => requestAvailability<ReviewerAbsenceOverview>(workspace, `/absences/${encodeURIComponent(absenceId)}`, {
        method: "PUT", body: JSON.stringify(availability),
      }));
    },
    async cancelReviewerAbsence(workspace, absenceId, expectedRevision) {
      return withUnauthorized(input.onUnauthorized, () => requestAvailability<ReviewerAbsenceOverview>(workspace, `/absences/${encodeURIComponent(absenceId)}/cancel`, {
        method: "POST", body: JSON.stringify({ expectedRevision }),
      }));
    },
    async listReviewerReplacementHistory(workspace, absenceId) {
      const query = absenceId === undefined ? "" : `?${new URLSearchParams({ absenceId })}`;
      return withUnauthorized(input.onUnauthorized, () => requestAvailability<ReviewerReplacementOverview[]>(workspace, `/replacements${query}`));
    },
    async queueRoutingRecovery(workspace, request) {
      return withUnauthorized(input.onUnauthorized, async () => {
        const response = await fetch("/api/operations/routing-runs", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            ...workspaceHeaders(workspace),
          },
          body: JSON.stringify(request),
        });
        if (response.status === 401) {
          throw new AdminApiError("The administrator session has expired.", 401);
        }
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { message?: string } | null;
          throw new AdminApiError(body?.message ?? "Could not queue the routing run.", response.status);
        }
        const queued = await response.json() as { jobId: string };
        return { jobId: queued.jobId };
      });
    },
  };
}

async function requestAvailability<T>(workspace: WorkspaceContext, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/operations/availability${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...workspaceHeaders(workspace),
      ...init.headers,
    },
  });
  if (response.status === 401) throw new AdminApiError("The administrator session has expired.", 401);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string; issues?: Array<{ message?: string }> } | null;
    throw new AdminApiError(body?.issues?.[0]?.message ?? body?.message ?? "Could not update reviewer availability.", response.status);
  }
  return response.json() as Promise<T>;
}

async function withUnauthorized<T>(onUnauthorized: ((message: string) => void) | undefined, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (caught) {
    notifyUnauthorized(caught, onUnauthorized);
    throw caught;
  }
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
  repository: RepositoryContext,
): Promise<EffectiveConfigurationOverview> {
  const query = new URLSearchParams({ repositoryId: repository.id });
  const response = await fetch(`/api/operations/effective-configuration?${query}`, {
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

export function createSelfHostedAnalyticsApi(input: {
  onUnauthorized?(message: string): void;
} = {}): AnalyticsApiClient {
  async function read<T>(workspace: WorkspaceContext, path: string, query: URLSearchParams, fallback: string, signal?: AbortSignal): Promise<T> {
    return withUnauthorized(input.onUnauthorized, async () => {
      const response = await fetch(`/api/operations/analytics${path}?${query}`, {
        credentials: "same-origin", headers: workspaceHeaders(workspace), ...(signal ? { signal } : {}),
      });
      if (response.status === 401) throw new AdminApiError("The administrator session has expired.", 401);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new AdminApiError(body?.message ?? fallback, response.status);
      }
      return response.json() as Promise<T>;
    });
  }
  return {
    readAnalytics(workspace, query, signal) {
      const params = new URLSearchParams({ periodDays: String(query.periodDays), mode: query.mode, averageReviewMinutes: String(query.averageReviewMinutes) });
      for (const id of query.repositoryIds) params.append("repositoryId", id);
      return read(workspace, "", params, "Could not load the analytics history.", signal);
    },
    readCurrentWorkload(workspace, query, signal) {
      const params = new URLSearchParams({ averageReviewMinutes: String(query.averageReviewMinutes) });
      for (const id of query.repositoryIds) params.append("repositoryId", id);
      if (query.forceRefresh !== undefined) params.set("forceRefresh", String(query.forceRefresh));
      return read(workspace, "/workload", params, "Could not load the current reviewer workload.", signal);
    },
  };
}

export function createSelfHostedPullRequestQueueApi(input: {
  onUnauthorized?(message: string): void;
} = {}): PullRequestQueueApiClient {
  return {
    readPullRequestQueue(workspace, query, signal) {
      return withUnauthorized(input.onUnauthorized, async () => {
        const params = new URLSearchParams();
        if (query.forceRefresh) params.set("refresh", "true");
        if (query.phase) params.set("phase", query.phase);
        const suffix = params.toString();
        const response = await fetch(`/api/operations/pull-requests${suffix ? `?${suffix}` : ""}`, {
          credentials: "same-origin",
          headers: workspaceHeaders(workspace),
          ...(signal ? { signal } : {}),
        });
        if (response.status === 401) throw new AdminApiError("The administrator session has expired.", 401);
        if (!response.ok) throw new AdminApiError("Could not load pull requests.", response.status);
        return response.json();
      });
    },
  };
}
