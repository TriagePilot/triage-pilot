import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Analytics,
  PullRequests,
  type PullRequestQueueApiClient,
  type AnalyticsApiClient,
  EffectiveConfiguration,
  OverviewPage,
  RepositoriesPage,
  RoutingDecisionsPage,
  SystemHealthPage,
  ReviewerAvailability,
  type AuthorizationCapabilities,
  type EffectiveConfigurationOverview,
  type OperationsPageNavigation,
  type OperationsApiClient,
  type OperationsOverview,
  type WorkspaceContext,
} from "@triagepilot/ui";

import {
  AdminApiError,
  createSelfHostedAnalyticsApi,
  createSelfHostedPullRequestQueueApi,
  createSelfHostedOperationsApi,
  getSession,
  login,
  logout,
} from "./api";

type AuthState = "checking" | "signed-out" | "signed-in";
type SectionId =
  | "pull-requests"
  | "analytics"
  | "overview"
  | "repositories"
  | "decisions"
  | "reviewer-availability"
  | "effective-configuration"
  | "system-health";

const sectionLabels: Record<SectionId, string> = {
  analytics: "Analytics",
  "pull-requests": "Pull requests",
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
const pageNavigation: OperationsPageNavigation = {
  hrefFor(target, params) {
    const section = target === "configuration" ? "effective-configuration" : target;
    const query = new URLSearchParams(params).toString();
    return `#${section}${query ? `?${query}` : ""}`;
  },
};
const defaultWorkspace = {
  id: "ws_local",
  displayName: localWorkspaceDisplayName,
};

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [username, setUsername] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = useMemo(
    () => createSelfHostedOperationsApi({ onUnauthorized: showSignedOut }),
    [],
  );

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
      setWorkspace({
        id: session.workspaceId,
        displayName: localWorkspaceDisplayName,
      });
      setAuthState("signed-in");
    } catch (caught) {
      showSignedOut();
      setError(
        messageFrom(caught, "Could not check the administrator session."),
      );
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
      setWorkspace({
        id: session.workspaceId,
        displayName: localWorkspaceDisplayName,
      });
      setAuthState("signed-in");
    } catch (caught) {
      setError(
        messageFrom(
          caught,
          "Sign in failed. Check the administrator credentials.",
        ),
      );
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
    setWorkspace(null);
    setUsername("");
    setAuthState("signed-out");
    setError(nextError);
  }

  if (authState === "checking")
    return <LoadingScreen message="Checking administrator session" />;
  if (authState === "signed-out") {
    return (
      <LoginScreen error={error} submitting={false} onSubmit={handleLogin} />
    );
  }
  if (!workspace) return <LoadingScreen message="Loading workspace" />;
  return (
    <Dashboard
      username={username}
      workspace={workspace}
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
          <span className="admin-badge">
            <span aria-hidden="true" />
            Admin
          </span>
        </div>
        <h1 id="login-title">Sign in to TriagePilot</h1>
        <p className="lede">
          Access routing health, reviewer availability, and operational records
          for this installation.
        </p>
        <div className="installation-note">
          <UiIcon name="shield" />
          <span>
            <strong>Self-hosted installation</strong>Credentials are verified on
            your infrastructure
          </span>
        </div>
        {error ? (
          <p id="login-error" role="alert" className="notice notice--danger">
            {error}
          </p>
        ) : null}
        <form
          onSubmit={(event) => void submit(event)}
          aria-describedby={error ? "login-error" : undefined}
        >
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
            {pending ? (
              "Signing in…"
            ) : (
              <>
                Sign in <span aria-hidden="true">→</span>
              </>
            )}
          </button>
        </form>
        <div className="session-note">
          <UiIcon name="lock" />
          Protected administrator session
        </div>
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
  analyticsApi?: AnalyticsApiClient;
  pullRequestQueueApi?: PullRequestQueueApiClient;
}

export function Dashboard({
  username,
  workspace = defaultWorkspace,
  overview,
  effectiveConfiguration,
  error,
  onLogout,
  onUnauthorized,
  api: providedApi,
  analyticsApi: providedAnalyticsApi,
  pullRequestQueueApi: providedPullRequestQueueApi,
}: DashboardProps) {
  const api = useMemo(
    () =>
      providedApi ??
      (overview
        ? fixedOverviewApi(overview)
        : createSelfHostedOperationsApi(
            onUnauthorized ? { onUnauthorized } : {},
          )),
    [providedApi, overview, onUnauthorized],
  );
  const analyticsApi = useMemo(
    () =>
      providedAnalyticsApi ??
      createSelfHostedAnalyticsApi(onUnauthorized ? { onUnauthorized } : {}),
    [providedAnalyticsApi, onUnauthorized],
  );
  const pullRequestQueueApi = useMemo(
    () => providedPullRequestQueueApi ?? createSelfHostedPullRequestQueueApi(onUnauthorized ? { onUnauthorized } : {}),
    [providedPullRequestQueueApi, onUnauthorized],
  );
  const [currentOverview, setCurrentOverview] = useState(overview);
  const [activeRoute, setActiveRoute] = useState(routeFromHash);
  const activeSection = activeRoute.section;
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const requestVersion = useRef(0);
  const inFlight = useRef(false);

  async function refreshOverview() {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++requestVersion.current;
    setRefreshing(true);
    setLoadError(null);
    try {
      const next = await api.readOperationsOverview(workspace);
      if (version === requestVersion.current) setCurrentOverview(next);
    } catch (caught) {
      if (version !== requestVersion.current) return;
      if (
        typeof caught === "object" &&
        caught !== null &&
        "status" in caught &&
        caught.status === 401
      )
        onUnauthorized?.(messageFrom(caught, "Session expired."));
      else
        setLoadError(
          messageFrom(caught, "Could not load the operations overview."),
        );
    } finally {
      if (version === requestVersion.current) {
        setRefreshing(false);
        inFlight.current = false;
      }
    }
  }
  async function refreshPage() {
    setRefreshKey((value) => value + 1);
    await refreshOverview();
  }
  useEffect(() => {
    setCurrentOverview(overview);
    if (!overview) void refreshOverview();
    return () => {
      requestVersion.current += 1;
      inFlight.current = false;
    };
  }, [api, workspace.id, overview]);

  useEffect(() => {
    const updateRoute = () => {
      setActiveRoute(routeFromHash());
      setNavigationOpen(false);
    };
    window.addEventListener("hashchange", updateRoute);
    window.addEventListener("popstate", updateRoute);
    return () => {
      window.removeEventListener("hashchange", updateRoute);
      window.removeEventListener("popstate", updateRoute);
    };
  }, []);

  const operationalPage =
    activeSection === "overview" ||
    activeSection === "repositories" ||
    activeSection === "decisions" ||
    activeSection === "system-health";
  const pageProps = currentOverview
    ? { overview: currentOverview,
        navigation: pageNavigation, refreshing, onRefresh: refreshOverview }
    : null;
  const selectedRepository =
    currentOverview?.repositories.find(
      (r) => r.id === activeRoute.repositoryId,
    ) ??
    (!activeRoute.repositoryId ? currentOverview?.repositories[0] : undefined);

  function sectionLink(id: SectionId, icon: string) {
    const active = activeSection === id;
    return (
      <a
        className={`nav-link${active ? " nav-link--active" : ""}`}
        href={`#${id}`}
        aria-current={active ? "location" : undefined}
      >
        <UiIcon name={icon} />
        {sectionLabels[id]}
      </a>
    );
  }

  return (
    <div className={`app-shell${navigationOpen ? " navigation-open" : ""}`}>
      <aside className="app-sidebar" id="application-sidebar">
        <Brand inverse />
        <div className="workspace-card">
          <span className="workspace-avatar">S</span>
          <span>
            <small>Installation</small>
            <strong>{workspace.displayName}</strong>
          </span>
        </div>
        <nav aria-label="Operations navigation">
          <span className="nav-label">Workspace</span>
          {sectionLink("overview", "overview")}
          {sectionLink("repositories", "repository")}
          {sectionLink("decisions", "route")}
          {sectionLink("pull-requests", "pull-request")}
          {sectionLink("analytics", "overview")}
          {sectionLink("reviewer-availability", "user")}
          {sectionLink("effective-configuration", "settings")}
          <span className="nav-label nav-label--secondary">Administration</span>
          {sectionLink("system-health", "health")}
        </nav>
        <div
          className={`worker-summary ${loadError ? "worker-summary--unknown" : currentOverview?.worker.available ? "worker-summary--healthy" : "worker-summary--failed"}`}
        >
          <span aria-hidden="true" />
          <strong>
            {loadError
              ? "Worker status unknown"
              : !currentOverview
                ? "Checking worker status"
                : currentOverview.worker.available
                  ? "Worker healthy"
                  : "Worker unavailable"}
          </strong>
          <small>
            {currentOverview?.worker.lastHeartbeatAt
              ? `Heartbeat ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(currentOverview.worker.lastHeartbeatAt))}`
              : "No heartbeat recorded"}
          </small>
        </div>
        <div className="sidebar-user">
          <span className="user-avatar">
            {username.slice(0, 2).toUpperCase()}
          </span>
          <span>
            <strong>{username}</strong>
            <small>Administrator</small>
          </span>
        </div>
      </aside>
      <div className="app-workspace">
        <header className="app-topbar">
          <button
            className="navigation-toggle button--quiet"
            aria-expanded={navigationOpen}
            aria-controls="application-sidebar"
            onClick={() => setNavigationOpen((value) => !value)}
          >
            {navigationOpen ? "Close navigation" : "Open navigation"}
          </button>
          <div>
            <span>Workspace</span>
            <span aria-hidden="true">/</span>
            <strong>{sectionLabels[activeSection]}</strong>
          </div>
          <div className="operator">
            <span>Signed in as {username}</span>
            <button
              className="button--quiet"
              type="button"
              onClick={() => void onLogout()}
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="shell">
          {activeSection === "pull-requests" ? (
            <PullRequests api={pullRequestQueueApi} workspace={workspace} authorization={selfHostedAuthorization} {...(onUnauthorized ? { onUnauthorized } : {})} />
          ) : null}
          {error ? (
            <p role="alert" className="notice notice--danger dashboard-notice">
              {error}
            </p>
          ) : null}
          {loadError ? (
            <div
              role="alert"
              className="notice notice--danger dashboard-notice"
            >
              <strong>
                {currentOverview
                  ? "Refresh failed. Showing the last loaded records."
                  : "The dashboard could not load"}
              </strong>
              <p>{loadError}</p>
              <button
                className="button--quiet"
                disabled={refreshing}
                onClick={() => void refreshOverview()}
              >
                Retry overview
              </button>
            </div>
          ) : null}
          {operationalPage && !pageProps ? (
            <section className="operations-state" role="status">
              <h1>{sectionLabels[activeSection]}</h1>
              <p>
                {loadError
                  ? "Retry to load operational data."
                  : "Loading operational data…"}
              </p>
            </section>
          ) : null}
          {activeSection === "overview" && pageProps ? (
            <OverviewPage {...pageProps} />
          ) : null}
          {activeSection === "repositories" && pageProps ? (
            <RepositoriesPage {...pageProps} />
          ) : null}
          {activeSection === "decisions" && pageProps ? (
            <RoutingDecisionsPage
              {...pageProps}
              api={api}
              workspace={workspace}
              authorization={selfHostedAuthorization}
              {...(activeRoute.decisionId
                ? { selectedDecisionId: activeRoute.decisionId }
                : {})}
              {...(onUnauthorized ? { onUnauthorized } : {})}
            />
          ) : null}
          {activeSection === "system-health" && pageProps ? (
            <SystemHealthPage {...pageProps} />
          ) : null}
          {activeSection === "analytics" ? (
            <Analytics
              api={analyticsApi}
              workspace={workspace}
              authorization={selfHostedAuthorization}
              onRefresh={refreshOverview}
              {...(onUnauthorized ? { onUnauthorized } : {})}
            />
          ) : null}
          {activeSection === "reviewer-availability" ? (
            <ReviewerAvailability
              api={api}
              workspace={workspace}
              authorization={selfHostedAuthorization}
              onRefresh={refreshOverview}
              {...(onUnauthorized ? { onUnauthorized } : {})}
            />
          ) : null}
          {activeSection === "effective-configuration" ? (
            <section className="page-grid configuration-page">
              <header className="operations-heading">
                <div>
                  <h1>Configuration</h1>
                  <p className="lede">
                    Inspect effective settings and where each value comes from.
                  </p>
                </div>
                <button
                  disabled={refreshing}
                  onClick={() => void refreshPage()}
                >
                  {refreshing ? "Refreshing…" : "Refresh configuration"}
                </button>
              </header>
              {!currentOverview ? (
                <p role="status">Loading repositories…</p>
              ) : currentOverview.repositories.length === 0 ? (
                <div className="data-section panel-body">
                  <h2>No repositories are connected</h2>
                  <p>
                    Configuration is read-only and comes from trusted repository
                    files. Check repository access in your provider
                    installation, then refresh repositories.
                  </p>
                  <a href="#repositories">View repositories →</a>
                </div>
              ) : (
                <>
                  <label className="repository-selector">
                    Repository
                    <select
                      aria-label="Configuration repository"
                      value={selectedRepository?.id ?? ""}
                      onChange={(event) => {
                        window.location.hash = `effective-configuration?repositoryId=${encodeURIComponent(event.target.value)}`;
                      }}
                    >
                      <option disabled value="">
                        Select a repository
                      </option>
                      {currentOverview.repositories.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.repository.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedRepository ? (
                    <EffectiveConfiguration
                      key={`${workspace.id}:${selectedRepository.id}:${refreshKey}`}
                      api={api}
                      workspace={workspace}
                      repository={selectedRepository}
                      authorization={selfHostedAuthorization}
                      navigation={{ hrefFor: () => "#effective-configuration" }}
                      {...(effectiveConfiguration &&
                      selectedRepository.id === overview?.repositories[0]?.id &&
                      refreshKey === 0
                        ? { initialConfiguration: effectiveConfiguration }
                        : {})}
                      {...(onUnauthorized ? { onUnauthorized } : {})}
                    />
                  ) : (
                    <p className="notice">
                      The selected repository is not available to this
                      installation. Select a connected repository.
                    </p>
                  )}
                </>
              )}
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function Brand({ inverse = false }: { inverse?: boolean }) {
  if (inverse) {
    return (
      <div className="brand brand--inverse" role="img" aria-label="TriagePilot">
        <img
          className="brand-mark"
          src="/assets/routing-mark-inverse.svg"
          alt=""
        />
        <span>TriagePilot</span>
      </div>
    );
  }
  return (
    <div className="brand brand--login" role="img" aria-label="TriagePilot">
      <img src="/assets/routing-mark.svg" alt="" />
      <span>TriagePilot</span>
    </div>
  );
}

function routeFromHash(): {
  section: SectionId;
  repositoryId?: string;
  decisionId?: string;
} {
  if (typeof window === "undefined") return { section: "overview" };
  const [path, query = ""] = window.location.hash.slice(1).split("?");
  const section = path === "configuration" ? "effective-configuration" : path;
  const params = new URLSearchParams(query);
  return {
    section:
      section && Object.hasOwn(sectionLabels, section)
        ? (section as SectionId)
        : "overview",
    ...(params.get("repositoryId")
      ? { repositoryId: params.get("repositoryId")! }
      : {}),
    ...(params.get("decisionId")
      ? { decisionId: params.get("decisionId")! }
      : {}),
  };
}

function UiIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    shield: (
      <path d="M12 3 5 6v5c0 4.6 3 8.2 7 10 4-1.8 7-5.4 7-10V6l-7-3Zm-3 9 2 2 4-5" />
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="3" />
        <path d="M6 20c.6-4 2.6-6 6-6s5.4 2 6 6" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    overview: (
      <>
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
      </>
    ),
    repository: (
      <>
        <path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Z" />
        <path d="M8 8h7M8 12h7" />
      </>
    ),
    route: (
      <>
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="18" cy="18" r="2" />
        <path d="M8 6h4a6 6 0 0 1 6 6v4" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" />
      </>
    ),
    "pull-request": <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10m8-13 4 4-4 4m0-4h1a3 3 0 0 1 3 3v6" /></>,
    health: <path d="M3 12h4l2-5 4 10 2-5h6" />,
  };
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
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
    async listReviewerAbsences() {
      return [];
    },
    async scheduleReviewerAbsence(_workspace, input) {
      return fixtureAbsence(
        input.externalActorId,
        input.startLocal,
        input.endLocal,
      );
    },
    async reviseReviewerAbsence(_workspace, absenceId, input) {
      return {
        ...fixtureAbsence(
          input.externalActorId,
          input.startLocal,
          input.endLocal,
        ),
        id: absenceId,
        revision: input.expectedRevision + 1,
      };
    },
    async cancelReviewerAbsence(_workspace, absenceId, expectedRevision) {
      return {
        ...fixtureAbsence("", "1970-01-01T00:00", "1970-01-01T00:01"),
        id: absenceId,
        status: "cancelled",
        revision: expectedRevision + 1,
      };
    },
    async listReviewerReplacementHistory() {
      return [];
    },
    async queueRoutingRecovery() {
      return { jobId: "fixture-job" };
    },
  };
}

function fixtureAbsence(
  externalActorId: string,
  startLocal: string,
  endLocal: string,
) {
  return {
    id: "fixture-absence",
    externalActorId,
    startAt: `${startLocal}:00.000Z`,
    endAt: `${endLocal}:00.000Z`,
    status: "upcoming" as const,
    revision: 1,
    cancelledAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function messageFrom(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

export { AdminApiError };
export type { OperationsOverview };
