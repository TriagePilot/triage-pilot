import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import type {
  AuthorizationCapabilities,
  NavigationHost,
  OperationsApiClient,
  OperationsOverview,
  WorkspaceContext,
} from "../api.js";

export interface OperationsDashboardProps {
  api: OperationsApiClient;
  workspace: WorkspaceContext;
  authorization: AuthorizationCapabilities;
  navigation: NavigationHost;
  initialOverview?: OperationsOverview;
  headerActions?: ReactNode;
  onUnauthorized?(message: string): void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; overview: OperationsOverview }
  | { status: "failed"; message: string };

export function OperationsDashboard({
  ...props
}: OperationsDashboardProps) {
  return <OperationsDashboardWorkspace key={props.workspace.id} {...props} />;
}

function OperationsDashboardWorkspace({
  api,
  workspace,
  authorization,
  navigation,
  initialOverview,
  headerActions,
  onUnauthorized,
}: OperationsDashboardProps) {
  const [state, setState] = useState<LoadState>(() => !authorization.canViewOperations
    ? { status: "failed", message: "Operations are not available for this workspace." }
    : initialOverview
      ? { status: "ready", overview: initialOverview }
      : { status: "loading" });
  const [recoveryUrl, setRecoveryUrl] = useState("");
  const [pendingRecovery, setPendingRecovery] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  const recoveryInFlight = useRef(false);

  async function loadOverview() {
    if (!authorization.canViewOperations) {
      setState({ status: "failed", message: "Operations are not available for this workspace." });
      return;
    }
    setState({ status: "loading" });
    try {
      setState({ status: "ready", overview: await api.readOperationsOverview(workspace) });
    } catch (caught) {
      if (isUnauthorized(caught)) {
        onUnauthorized?.(messageFrom(caught, "The operations session has expired."));
        return;
      }
      setState({ status: "failed", message: messageFrom(caught, "Could not load the operations overview.") });
    }
  }

  useEffect(() => {
    if (!authorization.canViewOperations) {
      setState({ status: "failed", message: "Operations are not available for this workspace." });
      return;
    }
    if (initialOverview) {
      setState({ status: "ready", overview: initialOverview });
      return;
    }
    void loadOverview();
  }, [api, workspace.id, authorization.canViewOperations, initialOverview]);

  async function queueRecovery(
    request: { decisionId: string } | { changeRequestUrl: string },
    key: string,
  ) {
    if (recoveryInFlight.current || !authorization.canRunRoutingRecovery) return;
    recoveryInFlight.current = true;
    setPendingRecovery(key);
    setRecoveryNotice(null);
    try {
      await api.queueRoutingRecovery(workspace, request);
      if ("changeRequestUrl" in request) setRecoveryUrl("");
      setRecoveryNotice({
        tone: "success",
        message: "Routing run queued. The new revision will appear after the worker processes it.",
      });
      await loadOverview();
    } catch (caught) {
      const message = messageFrom(caught, "Could not queue the routing run.");
      if (isUnauthorized(caught)) {
        onUnauthorized?.(message);
        return;
      }
      setRecoveryNotice({ tone: "danger", message });
    } finally {
      recoveryInFlight.current = false;
      setPendingRecovery(null);
    }
  }

  async function submitMissingRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await queueRecovery({ changeRequestUrl: recoveryUrl }, "missing-request");
  }

  if (state.status === "loading") {
    return (
      <section className="operations-state" role="status" aria-live="polite">
        {headerActions ? <div className="operations-actions operations-actions--state">{headerActions}</div> : null}
        <p className="eyebrow">{workspace.displayName}</p>
        <h1>Loading operational data</h1>
        <p className="lede">Reading the current installation state.</p>
      </section>
    );
  }

  if (state.status === "failed") {
    return (
      <section className="operations-state" aria-labelledby="overview-error-title">
        {headerActions ? <div className="operations-actions operations-actions--state">{headerActions}</div> : null}
        <p className="eyebrow">Operations unavailable</p>
        <h1 id="overview-error-title">The dashboard could not load</h1>
        <p role="alert" className="notice notice--danger">
          {state.message}
        </p>
        {authorization.canViewOperations ? (
          <div className="recovery-actions">
            <button type="button" onClick={() => void loadOverview()}>
              Retry overview
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  const overview = state.overview;
  return (
    <section className="operations-dashboard">
      <div className="operations-heading">
        <div>
          <p className="eyebrow">TriagePilot / read-only</p>
          <h1 id="dashboard-title">Operations ledger</h1>
        </div>
        {headerActions || authorization.canManageConfiguration ? (
          <div className="operations-actions">
            {headerActions}
            {authorization.canManageConfiguration ? (
              <a className="button-link button-link--quiet" href={navigation.hrefFor("configuration")}>
                Edit configuration
              </a>
            ) : null}
          </div>
        ) : null}
      </div>

      <section className="status-ledger" aria-label="Installation status">
        {overview.statuses.map((status) => (
          <StatusNode
            key={status.id}
            label={status.label}
            value={status.value}
            {...(status.detail === undefined ? {} : { detail: status.detail })}
            {...(status.state === undefined ? {} : { state: status.state })}
          />
        ))}
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

      <DataSection id="repositories" title="Connected repositories" count={overview.repositories.length}>
        <TableRegion labelledBy="repositories-heading">
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
                <EmptyRow columns={3}>No repositories are connected to this provider connection.</EmptyRow>
              ) : (
                overview.repositories.map((repository) => (
                  <tr key={repository.id}>
                    <th scope="row" className="data-text">
                      <ProviderLinkValue link={repository.repository} />
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
        </TableRegion>
      </DataSection>

      <DataSection id="decisions" title="Recent routing decisions" count={overview.decisions.length}>
        {authorization.canRunRoutingRecovery ? (
          <form className="routing-recovery-form" onSubmit={(event) => void submitMissingRequest(event)}>
            <div>
              <label htmlFor="routing-recovery-url">Run missing change request</label>
              <span className="cell-detail">Use its provider URL or reference when no routing decision exists yet.</span>
            </div>
            <input
              id="routing-recovery-url"
              type="url"
              required
              placeholder="https://provider.example/owner/repository/change/123"
              value={recoveryUrl}
              onChange={(event) => setRecoveryUrl(event.target.value)}
              disabled={pendingRecovery !== null}
            />
            <button type="submit" disabled={pendingRecovery !== null}>
              {pendingRecovery === "missing-request" ? "Queueing…" : "Run routing"}
            </button>
          </form>
        ) : null}
        {recoveryNotice ? (
          <div
            role={recoveryNotice.tone === "danger" ? "alert" : "status"}
            className={`notice notice--${recoveryNotice.tone} routing-notice`}
          >
            <span>{recoveryNotice.message}</span>
            {recoveryNotice.tone === "success" ? (
              <button
                className="button--quiet button--compact"
                type="button"
                disabled={pendingRecovery !== null}
                onClick={() => void loadOverview()}
              >
                Refresh ledger
              </button>
            ) : null}
          </div>
        ) : null}
        <TableRegion labelledBy="decisions-heading">
          <table>
            <caption className="sr-only">Recent routing decisions</caption>
            <thead>
              <tr>
                <th scope="col">Change request</th>
                <th scope="col">Risk</th>
                <th scope="col">Route</th>
                <th scope="col">Human review</th>
                <th scope="col">Outcome</th>
                <th scope="col">Reviewers</th>
                <th scope="col">Recorded</th>
                {authorization.canRunRoutingRecovery ? <th scope="col">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {overview.decisions.length === 0 ? (
                <EmptyRow columns={authorization.canRunRoutingRecovery ? 8 : 7}>
                  No routing decisions have been recorded yet.
                </EmptyRow>
              ) : (
                overview.decisions.map((decision) => (
                  <tr key={decision.id}>
                    <th scope="row">
                      <span className="data-text"><ProviderLinkValue link={decision.repository} /></span>
                      <span className="cell-detail">
                        {decision.changeRequest === null ? (
                          "—"
                        ) : (
                          <ProviderLinkValue link={decision.changeRequest} />
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
                    <td>
                      <span className="data-text">{decision.selectedReviewers.join(", ") || "—"}</span>
                      <ReviewerRequirement decision={decision} />
                    </td>
                    <td>
                      <time dateTime={decision.createdAt}>{formatDate(decision.createdAt)}</time>
                    </td>
                    {authorization.canRunRoutingRecovery ? (
                      <td>
                        {decision.changeRequest === null ? (
                          <span className="cell-detail">—</span>
                        ) : (
                          <button
                            className="button--compact"
                            type="button"
                            disabled={pendingRecovery !== null}
                            onClick={() => void queueRecovery({ decisionId: decision.id }, decision.id)}
                          >
                            {pendingRecovery === decision.id ? "Queueing…" : "Re-run routing"}
                          </button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableRegion>
      </DataSection>

      <div className="failure-grid">
        <DataSection id="job-failures" title="Permanent job failures" count={overview.failures.jobs.length} tone="danger">
          <TableRegion labelledBy="job-failures-heading">
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
          </TableRegion>
        </DataSection>

        <DataSection id="action-failures" title="Action failures" count={overview.failures.actions.length} tone="danger">
          <TableRegion labelledBy="action-failures-heading">
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
                      <th scope="row" className="data-text"><ProviderLinkValue link={failure.repository} /></th>
                      <td>{failure.error}</td>
                      <td><time dateTime={failure.failedAt}>{formatDate(failure.failedAt)}</time></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TableRegion>
        </DataSection>
      </div>
    </section>
  );
}

function ProviderLinkValue({ link }: { link: { label: string; href: string | null } }) {
  return link.href === null ? link.label : (
    <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
  );
}

function RiskBreakdown({ breakdown }: { breakdown: OperationsOverview["decisions"][number]["riskBreakdown"] }) {
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

function ReviewerRequirement({ decision }: { decision: OperationsOverview["decisions"][number] }) {
  if (decision.requestedReviewerCount === null || decision.requestedReviewerCount <= 0) return null;
  const reviewerShortfall = decision.reviewerShortfall ?? Math.max(
    0,
    decision.requestedReviewerCount - decision.selectedReviewers.length,
  );
  return (
    <span className="cell-detail">
      {decision.selectedReviewers.length} of {decision.requestedReviewerCount} required
      {reviewerShortfall > 0 ? ` · shortfall ${reviewerShortfall}` : ""}
    </span>
  );
}

function TableRegion({ labelledBy, children }: { labelledBy: string; children: React.ReactNode }) {
  return (
    <div className="table-scroll" role="region" tabIndex={0} aria-labelledby={labelledBy}>
      {children}
    </div>
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

function isUnauthorized(caught: unknown): boolean {
  return typeof caught === "object" && caught !== null && "status" in caught && caught.status === 401;
}
