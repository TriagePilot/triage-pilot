import { useEffect, useRef, useState } from "react";
import type { AnalyticsPeriodDays, AnalyticsReport, CurrentWorkloadReport, RepositoryMode } from "@triagepilot/contracts";
import type { AuthorizationCapabilities, WorkspaceContext } from "../api.js";
import type { AnalyticsApiClient } from "../analytics-api.js";
import { AnalyticsCharts, AnalyticsRisk } from "./AnalyticsCharts.js";

export interface AnalyticsProps {
  api: AnalyticsApiClient;
  workspace: WorkspaceContext;
  authorization: AuthorizationCapabilities;
  onUnauthorized?(message: string): void;
}
interface Resource<T> { key: string; data?: T; error?: string }
export function Analytics(props: AnalyticsProps): JSX.Element {
  return <AnalyticsWorkspace key={props.workspace.id} {...props} />;
}
function AnalyticsWorkspace({ api, workspace, authorization, onUnauthorized }: AnalyticsProps): JSX.Element {
  const [tab, setTab] = useState<"assignments" | "workload">("assignments");
  const [period, setPeriod] = useState<AnalyticsPeriodDays>(30);
  const [repositoryId, setRepositoryId] = useState("");
  const [minutesInput, setMinutesInput] = useState("30");
  const [minutes, setMinutes] = useState(30);
  const [mode, setMode] = useState<RepositoryMode | null>(null);
  const resolvedMode = useRef<RepositoryMode | null>(null);
  const [refresh, setRefresh] = useState(0);
  const lastRefresh = useRef(0);
  const [history, setHistory] = useState<Resource<AnalyticsReport> | null>(null);
  const [current, setCurrent] = useState<Resource<CurrentWorkloadReport> | null>(null);
  const [repositories, setRepositories] = useState<AnalyticsReport["repositories"]>([]);
  const callback = useRef(onUnauthorized);
  useEffect(() => { callback.current = onUnauthorized; }, [onUnauthorized]);
  const allowed = authorization.canViewOperations;
  const historyKey = JSON.stringify([period, repositoryId, minutes, mode]);
  const currentKey = JSON.stringify([repositoryId, minutes, refresh]);
  const validMinutes = /^\d+$/.test(minutesInput) && Number(minutesInput) >= 1 && Number(minutesInput) <= 480;

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    let active = true;
    setHistory({ key: historyKey });
    const query = { periodDays: period, mode: mode ?? resolvedMode.current ?? "auto", repositoryIds: repositoryId ? [repositoryId] : [], averageReviewMinutes: minutes } as const;
    void Promise.resolve().then(() => api.readAnalytics({ id: workspace.id, displayName: workspace.displayName }, query, controller.signal)).then((data) => {
      if (!active) return;
      resolvedMode.current = data.mode;
      setHistory({ key: historyKey, data });
      setRepositories((previous) => [...new Map([...previous, ...data.repositories].map((item) => [item.recordId, item])).values()]);
    }).catch((error: unknown) => {
      if (!active) return;
      const message = errorMessage(error);
      setHistory({ key: historyKey, error: message });
      if (unauthorized(error)) callback.current?.(message);
    });
    return () => { active = false; controller.abort(); };
  }, [api, workspace.id, workspace.displayName, allowed, historyKey, period, repositoryId, minutes, mode]);

  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    let active = true;
    setCurrent({ key: currentKey });
    const forceRefresh = refresh !== lastRefresh.current;
    lastRefresh.current = refresh;
    const query = { repositoryIds: repositoryId ? [repositoryId] : [], averageReviewMinutes: minutes, ...(forceRefresh ? { forceRefresh: true } : {}) };
    void Promise.resolve().then(() => api.readCurrentWorkload({ id: workspace.id, displayName: workspace.displayName }, query, controller.signal)).then((data) => {
      if (!active) return;
      setCurrent({ key: currentKey, data });
      setRepositories((previous) => [...new Map([...previous, ...data.scope.repositories].map((item) => [item.recordId, item])).values()]);
    }).catch((error: unknown) => {
      if (!active) return;
      const message = errorMessage(error);
      setCurrent({ key: currentKey, error: message });
      if (unauthorized(error)) callback.current?.(message);
    });
    return () => { active = false; controller.abort(); };
  }, [api, workspace.id, workspace.displayName, allowed, currentKey, repositoryId, minutes, refresh]);

  if (!allowed) return <section><p>You are not authorized to view analytics.</p></section>;
  // Never render results belonging to a previous filter, including before effects run.
  const historical = history?.key === historyKey ? history : null;
  const live = current?.key === currentKey ? current : null;
  const report = historical?.data;
  const workload = live?.data;
  const chosenMode = mode ?? resolvedMode.current;
  const actors = [...new Set([...(report?.assignments.map((row) => row.actor) ?? []), ...(workload?.rows.map((row) => row.actor) ?? [])])].sort();
  const currentLoading = !live || (!live.data && !live.error);
  return <section className="analytics-grid" aria-label="Analytics">
    <header className="operations-heading"><div><p className="eyebrow">Workspace insights · {workspace.displayName}</p><h2>Analytics</h2><p className="lede">Understand review demand, routing impact, and team capacity.</p></div></header>
    <div className="analytics-filter-bar"><div className="analytics-filters">
      <label>Repository scope<select aria-label="Repository scope" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}><option value="">All repositories</option>{repositories.map((item) => <option key={item.recordId} value={item.recordId}>{item.repository.owner}/{item.repository.name}</option>)}</select></label>
      <label>History period<select aria-label="History period" value={period} onChange={(event) => setPeriod(Number(event.target.value) as AnalyticsPeriodDays)}>{([7, 30, 90] as const).map((days) => <option key={days} value={days}>Last {days} days</option>)}</select></label>
      <label>Average review minutes<input aria-label="Average review minutes" type="number" min={1} max={480} step={1} value={minutesInput} aria-invalid={!validMinutes} onChange={(event) => {
        const value = event.target.value; setMinutesInput(value);
        if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 480) setMinutes(Number(value));
      }} /></label>
      {!validMinutes ? <p role="alert">Enter a whole number from 1 to 480 minutes.</p> : null}
    </div>
    <div className="analytics-modes" role="group" aria-label="Historical routing mode">
      <button type="button" aria-pressed={chosenMode === "enforce"} onClick={() => setMode("enforce")}>Enforced outcomes</button>
      <button type="button" aria-pressed={chosenMode === "shadow"} onClick={() => setMode("shadow")}>Shadow projections</button>
    </div>
    </div>
    <p className="cell-detail analytics-context">Tracked PRs only. Historical filters apply to summaries and assignments. The review estimate assumption does not change routing or historical records.</p>
    <div aria-live="polite" aria-busy={!historical || (!historical.data && !historical.error)}>
      {historical?.error ? <p role="alert">History unavailable: {historical.error}</p> : !report ? <p>Loading history…</p> : <>
        <p className="cell-detail analytics-context">Exact history period (UTC): <time dateTime={report.start}>{report.start}</time> inclusive to <time dateTime={report.end}>{report.end}</time> exclusive.</p>
        <div className="analytics-metrics">
          <div className="analytics-metric"><span>Assessed pull requests</span><strong>{report.counts.assessed}</strong><small>{report.counts.humanRequired} require human review</small></div>
          <div className="analytics-metric"><span>{report.savings.estimatedHoursSaved < 0 ? "Additional review effort" : "Estimated review effort saved"}</span><strong className={report.savings.estimatedHoursSaved < 0 ? "analytics-metric--caution" : ""}>{Math.abs(report.savings.estimatedHoursSaved).toFixed(1)} h</strong><small>{Math.abs(report.savings.netFewerReviews)} {report.savings.netFewerReviews < 0 ? "additional reviews" : "fewer reviews"} · {report.savings.reductionPercent === null ? "Unavailable" : `${Math.abs(report.savings.reductionPercent).toFixed(1)}% ${report.savings.reductionPercent < 0 ? "increase" : "reduction"}`}</small></div>
          <div className="analytics-metric"><span>No human review needed</span><strong className="analytics-metric--teal">{report.noHumanSharePercent === null ? "Unavailable" : `${report.noHumanSharePercent.toFixed(1)}%`}</strong><small>{report.counts.noHumanRequired} of {report.counts.assessed} assessed PRs</small></div>
          <div className="analytics-metric"><span>Pending reviews now</span><strong>{currentLoading ? "…" : display(workload?.totalPending)}</strong><small>{hours(workload?.totalEstimatedHours)} estimated effort · live snapshot</small></div>
        </div>
        <div className="analytics-summary">
          <AnalyticsRisk report={report} />
          <section className="data-section analytics-panel analytics-coverage"><h3>{report.savings.netFewerReviews < 0 ? "More review coverage, not less effort" : "Review coverage and effort"}</h3><strong>{report.savings.baselineReviews} baseline reviews → {report.savings.requiredReviews} required reviews</strong><p>Baseline: 1 reviewer per PR · Estimate: {report.query.averageReviewMinutes} min per review</p><p>{report.shortages.affectedPrs} PRs with reviewer shortages · {report.shortages.unknownPrs} with unknown shortage · {report.counts.couldNotAssess} could not be assessed</p></section>
        </div>
        <details className="analytics-details"><summary>Review calculation details</summary>
        <section className="data-section analytics-panel" aria-label="Review value">
          <h3>{report.mode === "shadow" ? "Projected review effort saved" : "Estimated review effort saved"}</h3>
          <strong className="analytics-value">{report.savings.estimatedHoursSaved < 0 ? `${Math.abs(report.savings.estimatedHoursSaved).toFixed(1)} h additional effort` : `${report.savings.estimatedHoursSaved.toFixed(1)} h`}</strong>
          <p>{Math.abs(report.savings.netFewerReviews)} {report.savings.netFewerReviews < 0 ? "additional reviews" : "fewer required human reviews"} · {report.savings.reductionPercent === null ? "Reduction unavailable" : `${Math.abs(report.savings.reductionPercent).toFixed(1)}% ${report.savings.reductionPercent < 0 ? "increase" : "reduction"}`}</p>
          <p>Baseline: 1 reviewer/PR | Average review: {report.query.averageReviewMinutes} minutes per review</p>
          <p>{report.savings.eligiblePrs} eligible PRs in the {report.mode === "shadow" ? "projection" : "successfully applied savings"} cohort; {report.savings.excludedPrs} excluded from effort-saved estimate.</p>
          <p>Reviewer shortages among assessed PRs: {report.shortages.affectedPrs} PRs; {report.shortages.missingReviewers} missing reviewers; {report.shortages.unknownPrs} PRs with unknown shortage.</p>
          {report.mode === "shadow" ? <p>Shadow projections have not enacted these savings or assignments.</p> : null}
          <p>Baseline reviews: {report.savings.baselineReviews}; required reviews: {report.savings.requiredReviews}.</p>
          <p>{report.counts.assessed === 0 ? "No assessments" : `${report.counts.assessed} assessed PRs`} · Human review required: {report.counts.humanRequired} · No human review required: {report.counts.noHumanRequired} ({report.noHumanSharePercent === null ? "Unavailable" : `${report.noHumanSharePercent.toFixed(1)}% of assessed PRs with known requirements`})</p>
          <p>Could not assess: {report.counts.couldNotAssess}; unknown review requirements: {report.counts.unknownRequirements}.</p>
        </section>
        </details>
      </>}
    </div>
    <div className="analytics-tabs" role="tablist" aria-label="Analytics views" onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = tab === "assignments" ? "workload" : "assignments"; setTab(next); document.getElementById(`analytics-${next}-tab`)?.focus(); } }}>
      <button type="button" role="tab" tabIndex={tab === "assignments" ? 0 : -1} aria-selected={tab === "assignments"} aria-controls="analytics-assignments" id="analytics-assignments-tab" onClick={() => setTab("assignments")}>Proposed assignments</button>
      <button type="button" role="tab" tabIndex={tab === "workload" ? 0 : -1} aria-selected={tab === "workload"} aria-controls="analytics-workload" id="analytics-workload-tab" onClick={() => setTab("workload")}>Reviewer workload</button>
    </div>
    <div id="analytics-assignments" role="tabpanel" aria-labelledby="analytics-assignments-tab" hidden={tab !== "assignments"}>{report ? <AnalyticsCharts report={report} /> : null}</div>
    <div id="analytics-workload" role="tabpanel" aria-labelledby="analytics-workload-tab" hidden={tab !== "workload"}>
    <section className="data-section analytics-panel" aria-label="Reviewer workload" aria-busy={currentLoading}>
      <h3>Reviewer workload</h3>
      <p>Current snapshot: {workload?.observedAt ? <time dateTime={workload.observedAt}>{workload.observedAt} (UTC)</time> : "Unavailable"}</p>
      <p>Current pending: actual provider requests on PRs tracked in the last 90 days. Manually added requests on tracked PRs count; never-assessed PRs do not.</p>
      <p>Current counts are independent of the selected history period and mode.</p>
      <p>All repositories is the appropriate scope for inspecting the load used by routing.</p>
      {currentLoading ? <p role="status">Loading current workload…</p> : live?.error ? <p role="alert">Unavailable: {live.error}</p> : <>
        <p>Current pending: {display(workload?.totalPending)} · Estimated review effort: {hours(workload?.totalEstimatedHours)} ({workload?.averageReviewMinutes} minutes per review)</p>
        <p className="cell-detail">Snapshot status: {workload?.status}. Tracked since: {workload?.trackedSince}. Repository coverage: {workload?.coveredRepositoryIds.length ?? 0} covered, {workload?.unavailableRepositoryIds.length ?? 0} unavailable.</p>
      </>}
      <div className="table-scroll" role="region" tabIndex={0} aria-label="Developer assignment and workload counts">
        <table><caption>Developer assignments in the selected history period and current tracked workload</caption><thead><tr><th scope="col">Developer</th><th scope="col">{chosenMode === "shadow" ? "Proposed assignments" : "Assigned in period"}</th><th scope="col">Share</th><th scope="col">Pending now</th><th scope="col">Est. review effort</th></tr></thead><tbody>
          {actors.length === 0 ? <tr><td colSpan={5}>No developer data available.</td></tr> : actors.map((actor) => {
            const assignment = report?.assignments.find((row) => row.actor === actor);
            const pending = workload?.rows.find((row) => row.actor === actor);
            const complete = workload?.status === "complete";
            return <tr key={actor}><th scope="row">{actor}</th><td>{report ? assignment?.count ?? 0 : "Unavailable"}</td><td>{report ? `${(assignment?.sharePercent ?? 0).toFixed(1)}%` : "Unavailable"}</td><td>{complete ? display(pending?.pendingCount ?? (pending ? null : 0)) : "Unavailable"}</td><td>{complete ? hours(pending?.estimatedHours ?? (pending ? null : 0)) : "Unavailable"}</td></tr>;
          })}
        </tbody></table>
      </div>
      <button type="button" onClick={() => setRefresh((value) => value + 1)}>Refresh current workload</button>
    </section>
    </div>
  </section>;
}
function display(value: number | null | undefined): string { return value === null || value === undefined ? "Unavailable" : String(value); }
function hours(value: number | null | undefined): string { return value === null || value === undefined ? "Unavailable" : `${value.toFixed(1)} h`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Could not load analytics."; }
function unauthorized(error: unknown): boolean { return typeof error === "object" && error !== null && "status" in error && error.status === 401; }
