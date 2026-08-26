import { useEffect, useState, type FormEvent } from "react";

import {
  AdminApiError,
  fetchAvailability,
  fetchOperationsOverview,
  getSession,
  login,
  logout,
  type AvailabilityOverview,
  type OperationsOverview,
} from "./api";
import { AvailabilityPanel } from "./Availability";

type AuthState = "checking" | "signed-out" | "signed-in";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [username, setUsername] = useState("");
  const [overview, setOverview] = useState<OperationsOverview | null>(null);
  const [availability, setAvailability] = useState<AvailabilityOverview | null>(null);
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
    setAvailability(null);
    try {
      const [overviewResult, availabilityResult] = await Promise.allSettled([
        fetchOperationsOverview(),
        fetchAvailability(),
      ]);
      const failures = [overviewResult, availabilityResult].filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      const expired = failures.find(
        (result) => result.reason instanceof AdminApiError && result.reason.status === 401,
      );
      if (expired) throw expired.reason;
      if (failures[0]) throw failures[0].reason;
      if (overviewResult.status !== "fulfilled" || availabilityResult.status !== "fulfilled") {
        throw new Error("Could not load the operations overview.");
      }
      setOverview(overviewResult.value);
      setAvailability(availabilityResult.value);
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
  if (!overview || !availability) {
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
      availability={availability}
      onAvailabilityChange={setAvailability}
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
  overview: OperationsOverview;
  availability: AvailabilityOverview;
  onAvailabilityChange(availability: AvailabilityOverview): void;
  error?: string | null;
  onLogout(): Promise<void>;
}

export function Dashboard({ username, overview, availability, onAvailabilityChange, error, onLogout }: DashboardProps) {
  return (
    <main className="shell" aria-labelledby="dashboard-title">
      <header className="topbar">
        <div>
          <p className="eyebrow">TriagePilot / operations</p>
          <h1 id="dashboard-title">Operations ledger</h1>
        </div>
        <div className="operator">
          <span>Signed in as {username}</span>
          <button className="button--quiet" type="button" onClick={() => void onLogout()}>
            Sign out
          </button>
        </div>
      </header>

      {error ? (
        <p role="alert" className="notice notice--danger dashboard-notice">
          {error}
        </p>
      ) : null}

      <section className="status-ledger" aria-label="Installation status">
        <StatusNode label="Organization" value={overview.organization} />
        <StatusNode
          label="GitHub App"
          value={overview.githubApp.configured ? `App ${overview.githubApp.appId}` : "Not configured"}
          detail={
            overview.githubApp.installationId
              ? `Installation ${overview.githubApp.installationId}`
              : "No active installation"
          }
        />
        <StatusNode
          label="Worker"
          value={overview.worker.available ? "Worker available" : "Worker unavailable"}
          detail={
            overview.worker.lastHeartbeatAt
              ? `Last heartbeat ${formatDate(overview.worker.lastHeartbeatAt)}`
              : "No heartbeat recorded"
          }
          state={overview.worker.available ? "healthy" : "failed"}
        />
      </section>

      <AvailabilityPanel availability={availability} onChange={onAvailabilityChange} />

      <DataSection id="repositories" title="Connected repositories" count={overview.repositories.length}>
        <div
          className="table-scroll"
          role="region"
          tabIndex={0}
          aria-labelledby="repositories-heading"
        >
          <table>
            <caption className="sr-only">Connected repositories</caption>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Configuration</th>
                <th scope="col">Mode</th>
              </tr>
            </thead>
            <tbody>
              {overview.repositories.length === 0 ? (
                <EmptyRow columns={3}>No repositories are connected to this installation.</EmptyRow>
              ) : (
                overview.repositories.map((repository) => (
                  <tr key={repository.id}>
                    <th scope="row" className="data-text">
                      {repository.owner}/{repository.name}
                    </th>
                    <td>
                      <StatusChip value={repository.configState} />
                    </td>
                    <td>
                      <StatusChip value={repository.mode} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </DataSection>

      <DataSection id="decisions" title="Recent routing decisions" count={overview.decisions.length}>
        <div
          className="table-scroll"
          role="region"
          tabIndex={0}
          aria-labelledby="decisions-heading"
        >
          <table>
            <caption className="sr-only">Recent routing decisions</caption>
            <thead>
              <tr>
                <th scope="col">Pull request</th>
                <th scope="col">Risk</th>
                <th scope="col">Route</th>
                <th scope="col">Human review</th>
                <th scope="col">Outcome</th>
                <th scope="col">Reviewers</th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {overview.decisions.length === 0 ? (
                <EmptyRow columns={7}>No routing decisions have been recorded yet.</EmptyRow>
              ) : (
                overview.decisions.map((decision) => (
                  <tr key={decision.id}>
                    <th scope="row">
                      <span className="data-text">{decision.repository}</span>
                      <span className="cell-detail">
                        {decision.pullNumber === null ? (
                          "—"
                        ) : (
                          <a
                            href={`https://github.com/${decision.repository}/pull/${decision.pullNumber}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            #{decision.pullNumber}
                          </a>
                        )}
                      </span>
                    </th>
                    <td>
                      <span className="data-text">{decision.riskScore}</span>
                      <RiskBreakdown breakdown={decision.riskBreakdown} />
                    </td>
                    <td>
                      <span className="data-text">{labelFor(decision.action)}</span>
                      <span className="cell-detail">{decision.mode}</span>
                    </td>
                    <td>
                      <HumanReviewStatusChip state={decision.policyCheckState} />
                    </td>
                    <td>
                      <StatusChip value={decision.actionStatus} />
                      {decision.actionError ? <span className="cell-error">{decision.actionError}</span> : null}
                    </td>
                    <td className="data-text">{decision.selectedReviewers.join(", ") || "—"}</td>
                    <td>
                      <time dateTime={decision.createdAt}>{formatDate(decision.createdAt)}</time>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </DataSection>

      <div className="failure-grid">
        <DataSection
          id="job-failures"
          title="Permanent job failures"
          count={overview.failures.jobs.length}
          tone="danger"
        >
          <div
            className="table-scroll"
            role="region"
            tabIndex={0}
            aria-labelledby="job-failures-heading"
          >
            <table>
              <caption className="sr-only">Permanent job failures</caption>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Error</th>
                  <th scope="col">Failed</th>
                </tr>
              </thead>
              <tbody>
                {overview.failures.jobs.length === 0 ? (
                  <EmptyRow columns={3}>No permanent job failures.</EmptyRow>
                ) : (
                  overview.failures.jobs.map((failure) => (
                    <tr key={failure.id}>
                      <th scope="row" className="data-text id-cell">{failure.id}</th>
                      <td>{failure.error}</td>
                      <td><time dateTime={failure.failedAt}>{formatDate(failure.failedAt)}</time></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </DataSection>

        <DataSection
          id="action-failures"
          title="Action failures"
          count={overview.failures.actions.length}
          tone="danger"
        >
          <div
            className="table-scroll"
            role="region"
            tabIndex={0}
            aria-labelledby="action-failures-heading"
          >
            <table>
              <caption className="sr-only">Action failures</caption>
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col">Error</th>
                  <th scope="col">Failed</th>
                </tr>
              </thead>
              <tbody>
                {overview.failures.actions.length === 0 ? (
                  <EmptyRow columns={3}>No action failures.</EmptyRow>
                ) : (
                  overview.failures.actions.map((failure) => (
                    <tr key={failure.decisionId}>
                      <th scope="row" className="data-text">{failure.repository}</th>
                      <td>{failure.error}</td>
                      <td><time dateTime={failure.failedAt}>{formatDate(failure.failedAt)}</time></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </DataSection>
      </div>
    </main>
  );
}

function RiskBreakdown({
  breakdown,
}: {
  breakdown: OperationsOverview["decisions"][number]["riskBreakdown"];
}) {
  if (!breakdown) return <span className="cell-detail">Breakdown unavailable</span>;

  return (
    <details className="risk-breakdown">
      <summary>Score breakdown</summary>
      <p className="risk-breakdown__meta">
        {breakdown.classifierVersion} · {breakdown.tier}
      </p>
      <ul>
        {breakdown.components.map((component, index) => (
          <li key={`${component.reason}-${index}`}>
            <span className="data-text risk-breakdown__score">{formatComponentScore(component)}</span>
            <span>
              <strong>{labelForRiskComponent(component.reason)}</strong>
              <span className="cell-detail">{component.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatComponentScore(component: { reason: string; score: number }): string {
  if (component.reason === "docs_or_test_suppressor") return "cap";
  return component.score >= 0 ? `+${component.score}` : String(component.score);
}

function labelForRiskComponent(reason: string): string {
  const labels: Record<string, string> = {
    changed_file_count: "Changed file count",
    large_line_delta: "Large line delta",
    dependency_lockfile_change: "Dependency lockfile change",
    migration_or_schema_change: "Migration or schema change",
    ai_authorship_signal: "AI authorship signal",
    docs_or_test_suppressor: "Documentation or test-only cap",
  };
  if (reason.startsWith("high_risk_path:")) {
    return `High-risk path: ${reason.slice("high_risk_path:".length)}`;
  }
  return labels[reason] ?? reason.replaceAll("_", " ");
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

function StatusNode({
  label,
  value,
  detail,
  state = "neutral",
}: {
  label: string;
  value: string;
  detail?: string;
  state?: "neutral" | "healthy" | "failed";
}) {
  return (
    <div className={`status-node status-node--${state}`}>
      <span className="status-label">{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function DataSection({
  id,
  title,
  count,
  tone = "neutral",
  children,
}: {
  id: string;
  title: string;
  count: number;
  tone?: "neutral" | "danger";
  children: React.ReactNode;
}) {
  return (
    <section className={`data-section data-section--${tone}`}>
      <div className="section-heading">
        <h2 id={`${id}-heading`}>{title}</h2>
        <span className="count" aria-label={`${count} records`}>{count}</span>
      </div>
      {children}
    </section>
  );
}

function EmptyRow({ columns, children }: { columns: number; children: React.ReactNode }) {
  return (
    <tr>
      <td className="empty-cell" colSpan={columns}>{children}</td>
    </tr>
  );
}

function StatusChip({ value }: { value: string }) {
  return <span className={`chip chip--${value.replaceAll("_", "-")}`}>{labelFor(value)}</span>;
}

function HumanReviewStatusChip({ state }: { state: OperationsOverview["decisions"][number]["policyCheckState"] }) {
  const tone = state === "success" ? "succeeded" : state === "failure" ? "failed" : "neutral";
  return <span className={`chip chip--${tone}`}>{humanReviewLabelFor(state)}</span>;
}

function humanReviewLabelFor(state: OperationsOverview["decisions"][number]["policyCheckState"]): string {
  switch (state) {
    case "in_progress":
      return "Waiting for approval";
    case "success":
      return "Approved";
    case "failure":
      return "Failed";
    case "not_started":
      return "Not started";
  }
}

function labelFor(value: string): string {
  return value.replaceAll("_", " ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function messageFrom(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}
