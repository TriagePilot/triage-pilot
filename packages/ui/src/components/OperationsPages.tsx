import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  DecisionOverview,
  OperationsOverview,
  OperationsApiClient,
  WorkspaceContext,
  AuthorizationCapabilities,
} from "../api.js";
import {
  Chip,
  formatDate,
  isUnauthorized,
  messageFrom,
  PageHeading,
  Pagination,
  Panel,
  ProviderLink,
  TableRegion,
} from "./PagePrimitives.js";

export interface OperationsPageNavigation {
  hrefFor(target: "overview" | "repositories" | "decisions" | "configuration" | "system-health", params?: { repositoryId?: string; decisionId?: string }): string;
}

export interface OperationsPageProps {
  navigation: OperationsPageNavigation;
  overview: OperationsOverview;
  refreshing?: boolean;
  onRefresh(): Promise<void>;
}
function Refresh({
  onRefresh,
  refreshing,
  label = "Refresh",
}: Pick<OperationsPageProps, "onRefresh" | "refreshing"> & { label?: string }) {
  return (
    <button
      type="button"
      disabled={refreshing}
      onClick={() => void onRefresh()}
    >
      {refreshing ? "Refreshing…" : label}
    </button>
  );
}
function Metrics({ values }: { values: [string, number | string, string][] }) {
  return (
    <div className="summary-metrics">
      {values.map(([label, value, detail]) => (
        <div className="summary-metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
          <small>{detail}</small>
        </div>
      ))}
    </div>
  );
}
export function OverviewPage({ overview, navigation, ...refresh }: OperationsPageProps) {
  const jobs = overview.failures.jobs.length,
    actions = overview.failures.actions.length;
  const invalid = overview.repositories.filter(
    (r) => r.configState !== "valid",
  ).length;
  return (
    <section className="page-grid" id="overview">
      <PageHeading
        title="Overview"
        description="Your installation at a glance. Start with what needs attention."
      >
        <a className="button-link" href={navigation.hrefFor("decisions")}>
          View routing decisions
        </a>
        <Refresh {...refresh} />
      </PageHeading>
      <div
        className={`installation-banner${overview.worker.available ? "" : " installation-banner--warning"}`}
      >
        <strong>
          {overview.worker.available
            ? "● Worker healthy"
            : "● Worker unavailable"}
        </strong>
        {overview.statuses.map((s) => (
          <span key={s.id}>
            {s.label}: {s.value}
          </span>
        ))}
      </div>
      <Metrics
        values={[
          [
            "Connected repositories",
            overview.repositories.length,
            invalid
              ? `${invalid} configurations need attention`
              : "All configurations valid",
          ],
          [
            "Recent routing decisions",
            overview.decisions.length,
            "Latest returned records · up to 50",
          ],
          [
            "Permanent job failures",
            jobs,
            "Historical failures to investigate",
          ],
          [
            "Action failures",
            actions,
            "Historical actions that were not applied",
          ],
        ]}
      />
      <div className="overview-columns">
        <Panel
          title="Needs your attention"
          action={<a href={navigation.hrefFor("system-health")}>View system health →</a>}
        >
          <div className="panel-body">
            {!overview.worker.available ? (
              <p className="notice notice--danger">
                The worker is unavailable. Check the worker process and database
                connection.
              </p>
            ) : null}
            {jobs + actions + invalid > 0 ? (
              <>
                <p className="notice notice--warning">
                  {jobs + actions} recorded failures · {invalid} configurations
                  need attention.
                </p>
                <h3>Review failures before retrying routing</h3>
                <p className="muted">
                  Credential failures and changed request heads need different
                  recovery steps.
                </p>
                <a href={navigation.hrefFor("system-health")}>Open failure details →</a>
                {invalid ? (
                  <p>
                    <a href={navigation.hrefFor("repositories")}>
                      Review repository configuration →
                    </a>
                  </p>
                ) : null}
              </>
            ) : (
              <p className="empty-message">
                No recorded failures or configuration issues. Review recent
                routing decisions to see how your installation is working.
              </p>
            )}
            {overview.repositories.length === 0 ? (
              <p>
                No repositories are connected to this provider connection. Check
                the installation’s repository access, then{" "}
                <a href={navigation.hrefFor("repositories")}>refresh repositories</a>.
              </p>
            ) : null}
          </div>
        </Panel>
        <Panel title="Installation">
          <dl className="installation-details">
            {overview.statuses.map((s) => (
              <div key={s.id}>
                <dt>{s.label}</dt>
                <dd>
                  {s.value}
                  {s.detail ? <small>{s.detail}</small> : null}
                </dd>
              </div>
            ))}
            <div>
              <dt>Repositories</dt>
              <dd>{overview.repositories.length} connected</dd>
            </div>
            <div>
              <dt>Enforce mode</dt>
              <dd>
                {
                  overview.repositories.filter((r) => r.mode === "enforce")
                    .length
                }{" "}
                repositories
              </dd>
            </div>
            <div>
              <dt>Worker</dt>
              <dd>
                {overview.worker.available
                  ? "Worker available"
                  : "Worker unavailable"}
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
      <Panel
        title="Latest routing decisions"
        action={<a href={navigation.hrefFor("decisions")}>View all →</a>}
      >
        <DecisionTable decisions={overview.decisions.slice(0, 3)} />
      </Panel>
    </section>
  );
}
export function RepositoriesPage({
  overview,
  navigation,
  ...refresh
}: OperationsPageProps) {
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("");
  const [configuration, setConfiguration] = useState("");
  const [page, setPage] = useState(1);
  const rows = overview.repositories.filter(
    (r) =>
      r.repository.label.toLowerCase().includes(search.toLowerCase()) &&
      (!mode || r.mode === mode) &&
      (!configuration || r.configState === configuration),
  );
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / 8)));
  const valid = overview.repositories.filter(
    (r) => r.configState === "valid",
  ).length;
  return (
    <section className="page-grid" id="repositories">
      <PageHeading
        title="Repositories"
        description="Inspect connected repositories, configuration health, and routing mode."
      >
        <Refresh {...refresh} label="Refresh repositories" />
      </PageHeading>
      <Metrics
        values={[
          [
            "Connected",
            overview.repositories.length,
            "Available to this installation",
          ],
          [
            "Valid configuration",
            `${valid} / ${overview.repositories.length}`,
            "Trusted configuration loaded",
          ],
          [
            "Enforce mode",
            overview.repositories.filter((r) => r.mode === "enforce").length,
            "Repositories with writes enabled",
          ],
        ]}
      />
      <p className="installation-banner">
        Shadow mode records routing decisions without changing requests. Review
        configuration before enabling enforce mode.
      </p>
      <Panel title="Connected repositories">
        <div className="filter-bar">
          <label className="search-filter">
            <span className="sr-only">Search repositories</span>
            <input
              aria-label="Search repositories"
              placeholder="Search repositories…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <Filter
            label="Repository mode"
            value={mode}
            onChange={(v) => {
              setMode(v);
              setPage(1);
            }}
            all="Mode: all"
            values={["shadow", "enforce"]}
          />
          <Filter
            label="Configuration state"
            value={configuration}
            onChange={(v) => {
              setConfiguration(v);
              setPage(1);
            }}
            all="Configuration: all"
            values={[
              ...new Set(overview.repositories.map((r) => r.configState)),
            ]}
          />
        </div>
        <TableRegion label="Connected repositories">
          <table>
            <caption className="sr-only">Connected repositories</caption>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Configuration</th>
                <th scope="col">Mode</th>
                <th scope="col">Configuration details</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice((current - 1) * 8, current * 8).map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    <ProviderLink link={r.repository} />
                  </th>
                  <td>
                    <Chip value={r.configState} />
                  </td>
                  <td>
                    <Chip value={r.mode} />
                  </td>
                  <td>
                    <a
                      href={navigation.hrefFor("configuration", { repositoryId: r.id })}
                      aria-label={`View configuration for ${r.repository.label}`}
                    >
                      View configuration →
                    </a>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty-cell">
                    {overview.repositories.length === 0
                      ? "No repositories are connected to this provider connection. Check repository access in your provider installation, then refresh."
                      : "No repositories match these filters. Adjust the search, mode, or configuration filter."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </TableRegion>
        <Pagination
          page={current}
          total={rows.length}
          size={8}
          onChange={setPage}
        />
      </Panel>
    </section>
  );
}
export interface RoutingDecisionsPageProps extends OperationsPageProps {
  api: OperationsApiClient;
  workspace: WorkspaceContext;
  authorization: AuthorizationCapabilities;
  selectedDecisionId?: string;
  onUnauthorized?(message: string): void;
}
export function RoutingDecisionsPage({
  overview,
  api,
  workspace,
  authorization,
  selectedDecisionId,
  onUnauthorized,
  ...refresh
}: RoutingDecisionsPageProps) {
  const [repository, setRepository] = useState("");
  const [risk, setRisk] = useState("");
  const [mode, setMode] = useState("");
  const [outcome, setOutcome] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(
    selectedDecisionId ?? null,
  );
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<{
    error: boolean;
    message: string;
  } | null>(null);
  useEffect(() => {
    setExpanded(selectedDecisionId ?? null);
    setRepository("");
    setRisk("");
    setMode("");
    setOutcome("");
    const index = overview.decisions.findIndex(
      (d) => d.id === selectedDecisionId,
    );
    setPage(index < 0 ? 1 : Math.floor(index / 6) + 1);
  }, [selectedDecisionId]);
  const rows = overview.decisions.filter(
    (d) =>
      (!repository || d.repository.label === repository) &&
      (!risk || (d.riskBreakdown?.tier ?? "unknown") === risk) &&
      (!mode || d.mode === mode) &&
      (!outcome || d.actionStatus === outcome),
  );
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / 6)));
  async function recover(
    request: { decisionId: string } | { changeRequestUrl: string },
    key: string,
  ) {
    if (inFlight.current || !authorization.canRunRoutingRecovery) return;
    inFlight.current = true;
    setPending(key);
    setNotice(null);
    try {
      await api.queueRoutingRecovery(workspace, request);
      if ("changeRequestUrl" in request) setUrl("");
      setNotice({
        error: false,
        message:
          "Routing run queued. The new revision will appear after the worker processes it.",
      });
      await refresh.onRefresh();
    } catch (error) {
      if (isUnauthorized(error))
        onUnauthorized?.(messageFrom(error, "Session expired."));
      else
        setNotice({
          error: true,
          message: messageFrom(error, "Could not queue the routing run."),
        });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void recover({ changeRequestUrl: url }, "missing-request");
  }
  const filter = (update: (v: string) => void) => (v: string) => {
    update(v);
    setPage(1);
  };
  return (
    <section className="page-grid" id="decisions">
      <PageHeading
        title="Routing decisions"
        description="Review routing outcomes, risk signals, and recovery options for each request."
      >
        <Refresh {...refresh} />
      </PageHeading>
      {authorization.canRunRoutingRecovery ? (
        <Panel title="Run a missing change request">
          <form className="missing-request-form" onSubmit={submit}>
            <label htmlFor="routing-recovery-url">
              Use its provider URL when no routing decision exists yet.
            </label>
            <div>
              <input
                id="routing-recovery-url"
                type="url"
                required
                placeholder="https://provider.example/owner/repository/change/123"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={pending !== null}
              />
              <button type="submit" disabled={pending !== null}>
                {pending === "missing-request" ? "Queueing…" : "Run routing"}
              </button>
            </div>
          </form>
        </Panel>
      ) : null}
      {notice ? (
        <p
          role={notice.error ? "alert" : "status"}
          className={`notice notice--${notice.error ? "danger" : "success"}`}
        >
          {notice.message}
        </p>
      ) : null}
      {selectedDecisionId &&
      !overview.decisions.some((d) => d.id === selectedDecisionId) ? (
        <p className="notice">
          Decision {selectedDecisionId} is outside the returned recent records.
        </p>
      ) : null}
      <Panel title="Recent routing decisions">
        <div className="filter-bar">
          <Filter
            label="Decision repository"
            value={repository}
            onChange={filter(setRepository)}
            all="Repository: all"
            values={[
              ...new Set(overview.decisions.map((d) => d.repository.label)),
            ]}
          />
          <Filter
            label="Decision risk"
            value={risk}
            onChange={filter(setRisk)}
            all="Risk: all"
            values={["low", "medium", "high", "unknown"]}
          />
          <Filter
            label="Decision mode"
            value={mode}
            onChange={filter(setMode)}
            all="Mode: all"
            values={["shadow", "enforce"]}
          />
          <Filter
            label="Decision outcome"
            value={outcome}
            onChange={filter(setOutcome)}
            all="Outcome: all"
            values={[...new Set(overview.decisions.map((d) => d.actionStatus))]}
          />
        </div>
        <DecisionTable
          decisions={rows.slice((current - 1) * 6, current * 6)}
          empty={
            overview.decisions.length === 0
              ? "No routing decisions have been recorded yet."
              : "No routing decisions match these filters. Adjust a filter to see more records."
          }
          expanded={expanded}
          onExpand={(id) => setExpanded(expanded === id ? null : id)}
          renderAction={
            authorization.canRunRoutingRecovery
              ? (d) =>
                  d.changeRequest ? (
                    <button
                      className="button--compact"
                      disabled={pending !== null || refresh.refreshing}
                      onClick={() => void recover({ decisionId: d.id }, d.id)}
                    >
                      {pending === d.id ? "Queueing…" : "Re-run routing"}
                    </button>
                  ) : null
              : undefined
          }
        />
        <Pagination
          page={current}
          total={rows.length}
          size={6}
          onChange={setPage}
        />
      </Panel>
      <p className="installation-banner">
        Showing returned records: up to 50 recent decisions. Risk labels reflect
        the recorded classification; older decisions may be unknown.
      </p>
    </section>
  );
}
function DecisionTable({
  decisions,
  empty = "No routing decisions have been recorded yet.",
  expanded,
  onExpand,
  renderAction,
}: {
  decisions: DecisionOverview[];
  empty?: string;
  expanded?: string | null;
  onExpand?(id: string): void;
  renderAction?: ((d: DecisionOverview) => React.ReactNode) | undefined;
}) {
  return (
    <TableRegion label="Recent routing decisions">
      <table className="decisions-table">
        <caption className="sr-only">Recent routing decisions</caption>
        <thead>
          <tr>
            {[
              "Change request",
              "Risk",
              "Mode",
              "Routing",
              "Outcome",
              "Reviewers",
              ...(onExpand ? ["Details"] : []),
            ].map((x) => (
              <th key={x} scope="col">
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {decisions.length === 0 ? (
            <tr>
              <td colSpan={onExpand ? 7 : 6} className="empty-cell">
                {empty}
              </td>
            </tr>
          ) : (
            decisions.map((d) => (
              <Fragment key={d.id}>
                <tr>
                  <th scope="row">
                    <ProviderLink link={d.repository} />
                    <span className="cell-detail">
                      {d.changeRequest ? (
                        <ProviderLink link={d.changeRequest} />
                      ) : (
                        "—"
                      )}
                    </span>
                  </th>
                  <td>
                    <Chip value={d.riskBreakdown?.tier ?? "Unknown"} />
                    <span className="cell-detail">Score {d.riskScore}</span>
                  </td>
                  <td>
                    <Chip value={d.mode} />
                  </td>
                  <td>{d.action.replaceAll("_", " ")}</td>
                  <td>
                    <Chip value={d.actionStatus} />
                  </td>
                  <td>{d.selectedReviewers.join(", ") || "—"}</td>
                  {onExpand ? (
                    <td>
                      <button
                        className="button--quiet button--compact"
                        aria-expanded={expanded === d.id}
                        aria-controls={`decision-${d.id}`}
                        onClick={() => onExpand(d.id)}
                      >
                        {expanded === d.id ? "Close details" : "View details"}
                      </button>
                    </td>
                  ) : null}
                </tr>
                {onExpand && expanded === d.id ? (
                  <tr>
                    <td colSpan={7} className="inspector-cell">
                      <div
                        id={`decision-${d.id}`}
                        className="decision-inspector"
                      >
                        <div className="inspector-heading">
                          <h3>Decision inspector</h3>
                          {renderAction?.(d)}
                        </div>
                        <dl className="inspector-grid">
                          <div>
                            <dt>Decision identifier</dt>
                            <dd>{d.id}</dd>
                          </div>
                          <div>
                            <dt>Recorded</dt>
                            <dd>
                              <time dateTime={d.createdAt}>
                                {formatDate(d.createdAt)}
                              </time>
                            </dd>
                          </div>
                          <div>
                            <dt>Human review</dt>
                            <dd>
                              {
                                {
                                  not_started: "Not started",
                                  in_progress: "Waiting for approval",
                                  success: "Approved",
                                  failure: "Failed",
                                }[d.policyCheckState]
                              }
                            </dd>
                          </div>
                          <div>
                            <dt>Reviewers</dt>
                            <dd>
                              {d.selectedReviewers.join(", ") ||
                                "None selected"}
                              {d.requestedReviewerCount !== null ? (
                                <small>
                                  {d.selectedReviewers.length} of{" "}
                                  {d.requestedReviewerCount} required ·
                                  shortfall{" "}
                                  {d.reviewerShortfall ??
                                    Math.max(
                                      0,
                                      d.requestedReviewerCount -
                                        d.selectedReviewers.length,
                                    )}
                                </small>
                              ) : null}
                            </dd>
                          </div>
                        </dl>
                        <h3>Score breakdown</h3>
                        {d.riskBreakdown ? (
                          <>
                            <p className="muted">
                              {d.riskBreakdown.classifierVersion} ·{" "}
                              {d.riskBreakdown.tier}
                            </p>
                            <ul className="score-components">
                              {d.riskBreakdown.components.map((c, i) => (
                                <li key={i}>
                                  <strong>
                                    {c.reason === "docs_or_test_suppressor"
                                      ? "cap"
                                      : c.score >= 0
                                        ? `+${c.score}`
                                        : c.score}
                                  </strong>
                                  <span>
                                    {c.reason.startsWith("author_rule:") ? `Author rule: ${c.reason.slice("author_rule:".length)}` : c.reason.replaceAll("_", " ")}
                                    <small>{c.detail}</small>
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : (
                          <p>
                            Breakdown unavailable. This decision has no recorded
                            risk classification.
                          </p>
                        )}
                        <h3>Action error</h3>
                        <pre className="error-detail">
                          {d.actionError ?? "No action error recorded."}
                        </pre>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))
          )}
        </tbody>
      </table>
    </TableRegion>
  );
}
export function SystemHealthPage({
  overview,
  navigation,
  ...refresh
}: OperationsPageProps) {
  const [tab, setTab] = useState<"jobs" | "actions">("jobs");
  const [page, setPage] = useState(1);
  const total = overview.failures[tab].length;
  const current = Math.min(page, Math.max(1, Math.ceil(total / 5)));
  return (
    <section className="page-grid" id="system-health">
      <PageHeading
        title="System health"
        description="Check current worker and provider status, then investigate historical failures."
      >
        <Refresh {...refresh} />
      </PageHeading>
      <div className="status-ledger">
        {overview.statuses.map((s) => (
          <div
            key={s.id}
            className={`status-node status-node--${s.state ?? "neutral"}`}
          >
            <span className="status-label">{s.label}</span>
            <strong>{s.value}</strong>
            {s.detail ? <small>{s.detail}</small> : null}
          </div>
        ))}
        <div
          className={`status-node status-node--${overview.worker.available ? "healthy" : "failed"}`}
        >
          <span className="status-label">Worker</span>
          <strong>
            {overview.worker.available
              ? "Worker available"
              : "Worker unavailable"}
          </strong>
          <small>
            {overview.worker.lastHeartbeatAt
              ? `Last heartbeat ${formatDate(overview.worker.lastHeartbeatAt)}`
              : "No heartbeat recorded"}
          </small>
          <small>Worker ID: {overview.worker.workerId ?? "Unknown"}</small>
        </div>
      </div>
      <Metrics
        values={[
          [
            "Permanent job failures",
            overview.failures.jobs.length,
            "Historical records · up to 25",
          ],
          [
            "Action failures",
            overview.failures.actions.length,
            "Historical records · up to 25",
          ],
        ]}
      />
      <p className="installation-banner">
        Historical failures remain visible after recovery and do not determine
        current worker health.
      </p>
      <Panel title="Historical failures">
        <div className="page-tabs" role="group" aria-label="Failure category">
          {(["jobs", "actions"] as const).map((t) => (
            <button
              key={t}
              aria-pressed={tab === t}
              onClick={() => {
                setTab(t);
                setPage(1);
              }}
            >
              {t === "jobs" ? "Job failures" : "Action failures"} (
              {overview.failures[t].length})
            </button>
          ))}
        </div>
        <TableRegion
          label={tab === "jobs" ? "Permanent job failures" : "Action failures"}
        >
          <table>
            <caption className="sr-only">
              {tab === "jobs" ? "Permanent job failures" : "Action failures"}
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  {tab === "jobs" ? "Job" : "Repository / decision"}
                </th>
                <th scope="col">Error</th>
                <th scope="col">Failed</th>
              </tr>
            </thead>
            <tbody>
              {tab === "jobs"
                ? overview.failures.jobs
                    .slice((current - 1) * 5, current * 5)
                    .map((f) => (
                      <tr key={f.id}>
                        <th scope="row">
                          <code>{f.id}</code>
                        </th>
                        <td>
                          <FailureError error={f.error} />
                        </td>
                        <td>
                          <time dateTime={f.failedAt}>
                            {formatDate(f.failedAt)}
                          </time>
                        </td>
                      </tr>
                    ))
                : overview.failures.actions
                    .slice((current - 1) * 5, current * 5)
                    .map((f) => (
                      <tr key={f.decisionId}>
                        <th scope="row">
                          <ProviderLink link={f.repository} />
                          <span className="cell-detail">
                            {overview.decisions.some(
                              (d) => d.id === f.decisionId,
                            ) ? (
                              <a href={navigation.hrefFor("decisions", { decisionId: f.decisionId })}>
                                View decision →
                              </a>
                            ) : (
                              <>Decision: {f.decisionId}</>
                            )}
                          </span>
                        </th>
                        <td>
                          <FailureError error={f.error} />
                        </td>
                        <td>
                          <time dateTime={f.failedAt}>
                            {formatDate(f.failedAt)}
                          </time>
                        </td>
                      </tr>
                    ))}
              {total === 0 ? (
                <tr>
                  <td colSpan={3} className="empty-cell">
                    {tab === "jobs"
                      ? "No permanent job failures."
                      : "No action failures."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </TableRegion>
        <Pagination page={current} total={total} size={5} onChange={setPage} />
      </Panel>
      <Panel title="Recovery guidance">
        <div className="panel-body">
          <h3>Resolve the cause before re-running</h3>
          <p>
            Check provider credentials, installation permissions, and worker
            logs for permission or connection errors. For a changed request
            head, inspect the latest revision and run routing again.
          </p>
          <p>
            Permanent job failures cannot be retried here. Use the request URL
            on the routing decisions page to queue a new run after correcting
            the cause.
          </p>
          <a href={navigation.hrefFor("decisions")}>Open routing decisions →</a>
        </div>
      </Panel>
    </section>
  );
}
function FailureError({ error }: { error: string }) {
  return (
    <details className="error-inspector">
      <summary>
        {error.length > 100 ? `${error.slice(0, 100)}…` : error}
      </summary>
      <pre className="error-detail">{error}</pre>
    </details>
  );
}
function Filter({
  label,
  value,
  onChange,
  all,
  values,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  all: string;
  values: string[];
}) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{all}</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {v.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>
  );
}
