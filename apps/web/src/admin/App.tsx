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
type SectionId = "overview" | "repositories" | "decisions" | "reviewer-availability" | "effective-configuration" | "system-health";

const sectionLabels: Record<SectionId, string> = {
  overview: "Overview",
  repositories: "Repositories",
  decisions: "Routing decisions",
  "reviewer-availability": "Reviewer availability",
  "effective-configuration": "Configuration",
  "system-health": "System health",
};

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
    <main className="center-stage login-stage">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <Brand />
          <span className="admin-badge"><span aria-hidden="true" />Admin</span>
        </div>
        <h1 id="login-title">Sign in to TriagePilot</h1>
        <p className="lede">Access routing health, reviewer availability, and operational records for this installation.</p>
        <div className="installation-note">
          <UiIcon name="shield" />
          <span><strong>Self-hosted installation</strong>Credentials are verified on your infrastructure</span>
        </div>
        {error ? (
          <p id="login-error" role="alert" className="notice notice--danger">
            {error}
          </p>
        ) : null}
        <form onSubmit={(event) => void submit(event)} aria-describedby={error ? "login-error" : undefined}>
          <label htmlFor="admin-username">Username</label>
          <div className="input-shell">
            <UiIcon name="user" />
            <input
              id="admin-username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <label htmlFor="admin-password">Password</label>
          <div className="input-shell">
            <UiIcon name="lock" />
            <input
              id="admin-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <button type="submit" disabled={pending}>
            {pending ? "Signing in…" : <>Sign in <span aria-hidden="true">→</span></>}
          </button>
        </form>
        <div className="session-note"><UiIcon name="lock" />Protected administrator session</div>
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
  const hasConfiguration = Boolean(effectiveConfiguration && effectiveRepository);
  const [currentOverview, setCurrentOverview] = useState(overview);
  const [activeSection, setActiveSection] = useState<SectionId>(() => sectionFromHash(hasConfiguration));

  useEffect(() => setCurrentOverview(overview), [overview]);

  useEffect(() => {
    const updateSection = () => setActiveSection(sectionFromHash(hasConfiguration));
    window.addEventListener("hashchange", updateSection);
    updateSection();
    return () => window.removeEventListener("hashchange", updateSection);
  }, [hasConfiguration]);

  function sectionLink(id: SectionId, icon: string) {
    const active = activeSection === id;
    return <a className={`nav-link${active ? " nav-link--active" : ""}`} href={`#${id}`} aria-current={active ? "location" : undefined}><UiIcon name={icon} />{sectionLabels[id]}</a>;
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <Brand inverse />
        <div className="workspace-card">
          <span className="workspace-avatar">S</span>
          <span><small>Installation</small><strong>{workspace.displayName}</strong></span>
        </div>
        <nav aria-label="Operations navigation">
          <span className="nav-label">Workspace</span>
          {sectionLink("overview", "overview")}
          {sectionLink("repositories", "repository")}
          {sectionLink("decisions", "route")}
          {sectionLink("reviewer-availability", "user")}
          {hasConfiguration ? sectionLink("effective-configuration", "settings") : null}
          <span className="nav-label nav-label--secondary">Administration</span>
          {sectionLink("system-health", "health")}
        </nav>
        <div className={`worker-summary ${currentOverview?.worker.available ? "worker-summary--healthy" : "worker-summary--failed"}`}>
          <span aria-hidden="true" />
          <strong>{currentOverview?.worker.available ? "Worker healthy" : "Worker unavailable"}</strong>
          <small>{currentOverview?.worker.lastHeartbeatAt ? `Heartbeat ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(currentOverview.worker.lastHeartbeatAt))}` : "No heartbeat recorded"}</small>
        </div>
        <div className="sidebar-user">
          <span className="user-avatar">{username.slice(0, 2).toUpperCase()}</span>
          <span><strong>{username}</strong><small>Administrator</small></span>
        </div>
      </aside>
      <div className="app-workspace">
        <header className="app-topbar">
          <div><span>Workspace</span><span aria-hidden="true">/</span><strong>{sectionLabels[activeSection]}</strong></div>
          <div className="operator">
            <span>Signed in as {username}</span>
            <button className="button--quiet" type="button" onClick={() => void onLogout()}>Sign out</button>
          </div>
        </header>
        <main className="shell" aria-labelledby="dashboard-title">
          {error ? <p role="alert" className="notice notice--danger dashboard-notice">{error}</p> : null}
          <OperationsDashboard
            api={api}
            workspace={workspace}
            authorization={selfHostedAuthorization}
            navigation={localNavigation}
            {...(overview ? { initialOverview: overview } : {})}
            {...(onUnauthorized ? { onUnauthorized } : {})}
            onOverviewChange={setCurrentOverview}
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
      </div>
    </div>
  );
}

function Brand({ inverse = false }: { inverse?: boolean }) {
  const logo = "/assets/triage-pilot-logo.png";
  if (inverse) {
    return (
      <div className="brand brand--inverse" role="img" aria-label="TriagePilot">
        <span className="brand-crop brand-crop--mark"><img src={logo} alt="" /></span>
        <span className="brand-crop brand-crop--wordmark"><img src={logo} alt="" /></span>
      </div>
    );
  }
  return <div className="brand"><img src={logo} alt="TriagePilot" /></div>;
}

function sectionFromHash(hasConfiguration: boolean): SectionId {
  if (typeof window === "undefined") return "overview";
  const hash = window.location.hash.slice(1);
  if (hash === "effective-configuration" && !hasConfiguration) return "overview";
  return Object.hasOwn(sectionLabels, hash) ? hash as SectionId : "overview";
}

function UiIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    shield: <path d="M12 3 5 6v5c0 4.6 3 8.2 7 10 4-1.8 7-5.4 7-10V6l-7-3Zm-3 9 2 2 4-5" />,
    user: <><circle cx="12" cy="8" r="3" /><path d="M6 20c.6-4 2.6-6 6-6s5.4 2 6 6" /></>,
    lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    overview: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    repository: <><path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Z" /><path d="M8 8h7M8 12h7" /></>,
    route: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 6h4a6 6 0 0 1 6 6v4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" /></>,
    health: <path d="M3 12h4l2-5 4 10 2-5h6" />,
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function LoadingScreen({ message }: { message: string }) {
  return (
    <main className="center-stage">
      <section className="state-card" role="status" aria-live="polite">
        <Brand />
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
