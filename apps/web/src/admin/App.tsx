import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  OperationsDashboard,
  type AuthorizationCapabilities,
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

const localWorkspace: WorkspaceContext = { id: "ws_local", displayName: "Self-hosted" };
const readOnlyAuthorization: AuthorizationCapabilities = {
  canViewOperations: true,
  canManageConfiguration: false,
};
const localNavigation: NavigationHost = {
  hrefFor: (target) => `#${target}`,
};

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [username, setUsername] = useState("");
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setAuthState("signed-in");
      await loadOverview();
    } catch (caught) {
      showSignedOut();
      setError(messageFrom(caught, "Could not check the administrator session."));
    }
  }

  async function loadOverview() {
    setError(null);
    setOverview(null);
    try {
      const api = createSelfHostedOperationsApi({ onUnauthorized: showSignedOut });
      setOverview(await api.readOperationsOverview(localWorkspace));
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
      setUsername(nextUsername);
      setAuthState("signed-in");
      await loadOverview();
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
    setUsername("");
    setAuthState("signed-out");
    setError(nextError);
  }

  if (authState === "checking") return <LoadingScreen message="Checking administrator session" />;
  if (authState === "signed-out") {
    return <LoginScreen error={error} submitting={false} onSubmit={handleLogin} />;
  }
  if (!overview) {
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
              <button type="button" onClick={() => void loadOverview()}>
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
      overview={overview}
      error={error}
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
  overview?: OperationsOverview;
  error?: string | null;
  onLogout(): Promise<void>;
  onUnauthorized?(message: string): void;
}

export function Dashboard({ username, overview, error, onLogout, onUnauthorized }: DashboardProps) {
  const api = useMemo(
    () => overview
      ? fixedOverviewApi(overview)
      : createSelfHostedOperationsApi(onUnauthorized ? { onUnauthorized } : {}),
    [overview, onUnauthorized],
  );

  return (
    <main className="shell" aria-labelledby="dashboard-title">
      {error ? (
        <p role="alert" className="notice notice--danger dashboard-notice">
          {error}
        </p>
      ) : null}

      <OperationsDashboard
        api={api}
        workspace={localWorkspace}
        authorization={readOnlyAuthorization}
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
      />
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
  };
}

function messageFrom(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

export { AdminApiError };
export type { OperationsOverview };
