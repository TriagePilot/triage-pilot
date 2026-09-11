import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  EffectiveConfiguration,
  OperationsDashboard,
  ReviewerAvailability,
  type AuthorizationCapabilities,
  type EffectiveConfigurationOverview,
  type NavigationHost,
  type OperationsApiClient,
  type OperationsOverview,
  type WorkspaceContext,
} from "@triagepilot/ui";

import {
  AdminApiError,
  createSelfHostedOperationsApi,
  getSession,
  login,
  logout,
} from "./api";

type AuthState = "checking" | "signed-out" | "signed-in";

const localWorkspaceDisplayName = "Self-hosted";
const selfHostedAuthorization: AuthorizationCapabilities = {
  canViewOperations: true,
  canManageConfiguration: false,
  canManageReviewerAvailability: true,
  canRunRoutingRecovery: true,
};
const localNavigation: NavigationHost = {
  hrefFor: (target) => `#${target}`,
};

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [username, setUsername] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [effectiveConfiguration, setEffectiveConfiguration] = useState<EffectiveConfigurationOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = useMemo(() => createSelfHostedOperationsApi({ onUnauthorized: showSignedOut }), []);

  useEffect(() => {
    void loadSession();
  }, []);

  async function loadSession() {
    setError(null);
    try {
      const session = await getSession();
      if (!session.authenticated) {
        showSignedOut();
        return;
      }
      setUsername(session.username);
      setWorkspace({ id: session.workspaceId, displayName: localWorkspaceDisplayName });
      setAuthState("signed-in");
      await loadOverview({ id: session.workspaceId, displayName: localWorkspaceDisplayName });
    } catch (caught) {
      showSignedOut();
      setError(messageFrom(caught, "Could not check the administrator session."));
    }
  }

  async function loadOverview(activeWorkspace: WorkspaceContext) {
    setError(null);
    setOverview(null);
    setEffectiveConfiguration(null);
    try {
      const nextOverview = await api.readOperationsOverview(activeWorkspace);
      const repository = nextOverview.repositories[0];
      const nextEffectiveConfiguration = repository
        ? await api.readEffectiveConfiguration(activeWorkspace, repository)
        : null;
      setOverview(nextOverview);
      setEffectiveConfiguration(nextEffectiveConfiguration);
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        showSignedOut(caught.message);
        return;
      }
      setError(messageFrom(caught, "Could not load the operations overview."));
    }
  }

  async function handleLogin(nextUsername: string, password: string) {
    setError(null);
    try {
      await login(nextUsername, password);
      const session = await getSession();
      if (!session.authenticated) {
        showSignedOut();
        return;
      }
      setUsername(nextUsername);
      setWorkspace({ id: session.workspaceId, displayName: localWorkspaceDisplayName });
      setAuthState("signed-in");
      await loadOverview({ id: session.workspaceId, displayName: localWorkspaceDisplayName });
    } catch (caught) {
      setError(messageFrom(caught, "Sign in failed. Check the administrator credentials."));
    }
  }

  async function handleLogout() {
    setError(null);
    try {
      await logout();
      showSignedOut();
    } catch (caught) {
      setError(messageFrom(caught, "Could not sign out."));
    }
  }

  function showSignedOut(nextError: string | null = null) {
    setOverview(null);
    setEffectiveConfiguration(null);
    setWorkspace(null);
    setUsername("");
    setAuthState("signed-out");
    setError(nextError);
  }

  if (authState === "checking") return <LoadingScreen message="Checking administrator session" />;
  if (authState === "signed-out") {
    return <LoginScreen error={error} submitting={false} onSubmit={handleLogin} />;
  }
  if (!overview || !workspace) {
    if (error) {
      return (
        <main className="center-stage">
          <section className="state-card" aria-labelledby="overview-error-title">
            <p className="eyebrow">Operations unavailable</p>
            <h1 id="overview-error-title">The dashboard could not load</h1>
            <p role="alert" className="notice notice--danger">
              {error}
            </p>
            <div className="recovery-actions">
              <button type="button" onClick={() => workspace ? void loadOverview(workspace) : void loadSession()}>
                Retry overview
              </button>
              <button className="button--quiet" type="button" onClick={() => void handleLogout()}>
                Sign out
              </button>
            </div>
          </section>
        </main>
      );
    }
    return <LoadingScreen message="Loading operational data" />;
  }

  return (
    <Dashboard
      username={username}
      workspace={workspace}
      overview={overview}
      {...(effectiveConfiguration === null ? {} : { effectiveConfiguration })}
      error={error}
      api={api}
      onUnauthorized={showSignedOut}
      onLogout={handleLogout}
    />
  );
}

interface LoginScreenProps {
  error: string | null;
  submitting: boolean;
  onSubmit(username: string, password: string): Promise<void>;
}

export function LoginScreen({ error, submitting, onSubmit }: LoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(submitting);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      await onSubmit(username, password);
      setPassword("");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="center-stage">
      <section className="login-card" aria-labelledby="login-title">
        <div className="product-mark" aria-hidden="true">
          TP
        </div>
        <p className="eyebrow">Self-hosted operations</p>
        <h1 id="login-title">Administrator sign in</h1>
        <p className="lede">Inspect routing health for this TriagePilot installation.</p>
        {error ? (
          <p id="login-error" role="alert" className="notice notice--danger">
            {error}
          </p>
        ) : null}
        <form onSubmit={(event) => void submit(event)} aria-describedby={error ? "login-error" : undefined}>
          <label htmlFor="admin-username">Username</label>
          <input
            id="admin-username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
          <label htmlFor="admin-password">Password</label>
          <input
            id="admin-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

interface DashboardProps {
  username: string;
  workspace?: WorkspaceContext;
  overview?: OperationsOverview;
  effectiveConfiguration?: EffectiveConfigurationOverview;
  error?: string | null;
  onLogout(): Promise<void>;
  onUnauthorized?(message: string): void;
  api?: OperationsApiClient;
}

export function Dashboard({
  username,
  workspace = { id: "ws_local", displayName: localWorkspaceDisplayName },
  overview,
  effectiveConfiguration,
  error,
  onLogout,
  onUnauthorized,
  api: providedApi,
}: DashboardProps) {
  const api = useMemo(
    () => providedApi ?? (overview
      ? fixedOverviewApi(overview)
      : createSelfHostedOperationsApi(onUnauthorized ? { onUnauthorized } : {})),
    [providedApi, overview, onUnauthorized],
  );
  const effectiveRepository = overview?.repositories[0];

  return (
    <main className="shell" aria-labelledby="dashboard-title">
      {error ? (
        <p role="alert" className="notice notice--danger dashboard-notice">
          {error}
        </p>
      ) : null}

      <OperationsDashboard
        api={api}
        workspace={workspace}
        authorization={selfHostedAuthorization}
        navigation={localNavigation}
        {...(overview ? { initialOverview: overview } : {})}
        headerActions={
          <div className="operator">
            <span>Signed in as {username}</span>
            <button className="button--quiet" type="button" onClick={() => void onLogout()}>
              Sign out
            </button>
          </div>
        }
        {...(onUnauthorized ? { onUnauthorized } : {})}
      />
      <ReviewerAvailability
        api={api}
        workspace={workspace}
        authorization={selfHostedAuthorization}
        {...(onUnauthorized ? { onUnauthorized } : {})}
      />
      {effectiveConfiguration && effectiveRepository ? (
        <EffectiveConfiguration
          api={api}
          workspace={workspace}
          repository={effectiveRepository}
          authorization={selfHostedAuthorization}
          navigation={localNavigation}
          initialConfiguration={effectiveConfiguration}
        />
      ) : null}
    </main>
  );
}

function LoadingScreen({ message }: { message: string }) {
  return (
    <main className="center-stage">
      <section className="state-card" role="status" aria-live="polite">
        <div className="product-mark" aria-hidden="true">TP</div>
        <p className="eyebrow">Self-hosted operations</p>
        <h1>{message}</h1>
        <p className="lede">Reading the current installation state.</p>
      </section>
    </main>
  );
}

function fixedOverviewApi(overview: OperationsOverview): OperationsApiClient {
  return {
    async readOperationsOverview() {
      return overview;
    },
    async readEffectiveConfiguration() {
      throw new Error("Effective configuration is unavailable in this view.");
    },
    async readAvailabilitySettings() {
      return { timezone: "UTC", updatedAt: new Date(0).toISOString() };
    },
    async updateAvailabilityTimezone(_workspace, timezone) {
      return { timezone, updatedAt: new Date(0).toISOString() };
    },
    async listReviewerAbsences() { return []; },
    async scheduleReviewerAbsence(_workspace, input) {
      return fixtureAbsence(input.externalActorId, input.startLocal, input.endLocal);
    },
    async reviseReviewerAbsence(_workspace, absenceId, input) {
      return { ...fixtureAbsence(input.externalActorId, input.startLocal, input.endLocal), id: absenceId, revision: input.expectedRevision + 1 };
    },
    async cancelReviewerAbsence(_workspace, absenceId, expectedRevision) {
      return { ...fixtureAbsence("", "1970-01-01T00:00", "1970-01-01T00:01"), id: absenceId, status: "cancelled", revision: expectedRevision + 1 };
    },
    async listReviewerReplacementHistory() { return []; },
    async queueRoutingRecovery() { return { jobId: "fixture-job" }; },
  };
}

function fixtureAbsence(externalActorId: string, startLocal: string, endLocal: string) {
  return {
    id: "fixture-absence", externalActorId, startAt: `${startLocal}:00.000Z`, endAt: `${endLocal}:00.000Z`,
    status: "upcoming" as const, revision: 1, cancelledAt: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

function messageFrom(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

export { AdminApiError };
export type { OperationsOverview };
