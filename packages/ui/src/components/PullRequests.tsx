import { useEffect, useRef, useState } from "react";
import { queuePullRequestKey, type PullRequestQueueSnapshot, type QueueGroup } from "@triagepilot/contracts";
import type { AuthorizationCapabilities, WorkspaceContext } from "../api.js";
import type { PullRequestQueueApiClient } from "../pull-request-queue-api.js";
import { buildPullRequestQueueView, matchedQueueRoles, type PullRequestQueueFilters } from "../pull-request-queue-view.js";
import { PullRequestDetails } from "./PullRequestDetails.js";

export interface PullRequestsProps { api: PullRequestQueueApiClient; workspace: WorkspaceContext; authorization: AuthorizationCapabilities; onUnauthorized?(message: string): void }
const labels: Record<QueueGroup, string> = { reviewers: "Waiting for reviewers", authors: "Waiting for authors", reviewer_gap: "Needs a reviewer", policy_met: "Review policy met", other: "Checking and unknown status" };
const badges = { reviewers_move: "Waiting for reviewers", authors_move: "Waiting for author", needs_reviewer: "Needs a reviewer", policy_met: "Review policy met", draft: "Draft", checking: "Checking", status_unknown: "Status unknown", policy_unknown: "Policy unknown" } as const;
const initial: PullRequestQueueFilters = { personId: null, repositoryIds: [], query: "", group: null, sort: "activity" };
export function PullRequests(props: PullRequestsProps): JSX.Element { return <QueueWorkspace key={props.workspace.id} {...props} />; }
function QueueWorkspace({ api, workspace, authorization, onUnauthorized }: PullRequestsProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<PullRequestQueueSnapshot | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState(initial); const [personQuery, setPersonQuery] = useState("");
  const [limits, setLimits] = useState<Partial<Record<QueueGroup, number>>>({});
  const [selected, setSelected] = useState<{ key: string; trigger: HTMLElement | null } | null>(null);
  const [refresh, setRefresh] = useState(0); const generation = useRef(0); const callback = useRef(onUnauthorized); callback.current = onUnauthorized;
  const lastRefresh = useRef<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const activeRun = useRef<{ id: string | null; startedAt: number } | null>(null);
  useEffect(() => {
    const current = ++generation.current; const controller = new AbortController(); let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined; let inFlight = false;
    let stopped = false;
    const currentWorkspace = { id: workspace.id, displayName: workspace.displayName };
    if (!authorization.canViewOperations) { setSnapshot(null); setSelected(null); setLoading(false); return () => { active = false; controller.abort(); }; }
    setLoading(true); setError(null);
    const schedule = (delay: number) => { if (active && !document.hidden && !stopped) timer = setTimeout(() => void read(false), delay); };
    const read = async (forceRefresh: boolean) => {
      if (!active || document.hidden || inFlight) return;
      inFlight = true;
      try {
        const data = await api.readPullRequestQueue(currentWorkspace, { forceRefresh, phase: "initial" }, controller.signal);
        if (!active || generation.current !== current || data.workspaceId !== workspace.id) return;
        setSnapshot(data);
        setSelected((selection) => selection && data.items.some(({ pullRequest }) => queuePullRequestKey(pullRequest.repository, pullRequest.number) === selection.key) ? selection : null);
        setLoading(false); setError(null);
        const healthyActive = data.workerAvailable && data.syncState === "syncing" && (data.syncProgress.phase === "queued" || data.syncProgress.phase === "running") && !data.syncProgress.retryAt;
        if (healthyActive && (!activeRun.current || activeRun.current.id !== data.syncProgress.runId)) activeRun.current = { id: data.syncProgress.runId, startedAt: Date.now() };
        const expired = healthyActive && activeRun.current !== null && Date.now() - activeRun.current.startedAt >= 120_000;
        setTimedOut(expired);
        stopped = !data.workerAvailable;
        schedule(healthyActive && !expired ? 2_000 : 30_000);
      } catch (reason: unknown) {
        if (!active || generation.current !== current) return;
        const message = reason instanceof Error ? reason.message : "Could not load pull requests.";
        const status = typeof reason === "object" && reason !== null && "status" in reason ? reason.status : null;
        if (status === 401 || status === 403 || status === 404) { setSnapshot(null); setSelected(null); }
        setError(message); setLoading(false); setTimedOut(false); stopped = true;
        if (typeof reason === "object" && reason !== null && "status" in reason && reason.status === 401) callback.current?.(message);
      } finally { inFlight = false; }
    };
    const visibility = () => {
      if (timer) clearTimeout(timer);
      if (!document.hidden) { stopped = false; void read(false); }
    };
    document.addEventListener("visibilitychange", visibility);
    if (!document.hidden) void read(refresh > 0);
    return () => { active = false; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); controller.abort(); };
  }, [api, workspace.id, workspace.displayName, authorization.canViewOperations, refresh]);
  const requestRefresh = () => {
    const now = Date.now();
    if (lastRefresh.current !== null && now - lastRefresh.current < 60_000) return;
    lastRefresh.current = now; setRefresh((value) => value + 1);
  };
  if (!authorization.canViewOperations) return <section><p>You are not authorized to view pull requests.</p></section>;
  const selectedItem = selected ? snapshot?.items.find(({ pullRequest }) => queuePullRequestKey(pullRequest.repository, pullRequest.number) === selected.key) : undefined;
  const view = snapshot ? buildPullRequestQueueView(snapshot, filters) : null;
  const filtered = !!filters.personId || !!filters.repositoryIds.length || !!filters.query.trim() || !!filters.group;
  return <section className="queue" aria-label="Pull requests"><header className="operations-heading"><div><p className="eyebrow">Workspace · {workspace.displayName}</p><h2>Pull requests</h2><p>Open pull requests across the workspace, excluding drafts and bot-authored PRs.</p><p className="queue-context">Shared administrator login · Everyone is shown by default. Choose a person to see authored or requested reviews.</p></div><button type="button" disabled={loading} onClick={requestRefresh}>Refresh</button></header>
    {loading ? <p className="queue-message queue-message--info" role="status">{snapshot ? "Updating pull requests…" : "Loading pull requests…"}</p> : null}
    {error ? <p className="queue-message queue-message--error" role="alert">Pull requests unavailable: {error}</p> : null}
    {snapshot ? <><p className="queue-summary">Last updated: {snapshot.observedAt ? <time dateTime={snapshot.observedAt}>{snapshot.observedAt}</time> : "Unknown"} · {snapshot.totalOpen === null ? "Total unavailable" : `${snapshot.totalOpen} open`} · {view?.filteredCount} shown</p>
      {snapshot.stale ? <p className="queue-message queue-message--warning" role="alert">Stale snapshot{snapshot.refreshError ? `: ${snapshot.refreshError}` : ""}</p> : snapshot.refreshError ? <p className="queue-message queue-message--error" role="alert">Refresh failed: {snapshot.refreshError}</p> : null}
      {!snapshot.workerAvailable ? <p className="queue-message queue-message--warning" role="alert">Worker unavailable. Showing the last available data.</p> : null}
      {snapshot.syncState === "syncing" && snapshot.workerAvailable && !snapshot.syncProgress.retryAt && !timedOut && !error ? <p className="queue-message queue-message--info" role="status">Syncing pull requests… {snapshot.syncProgress.completedRepositories}{snapshot.syncProgress.totalRepositories === null ? "" : ` / ${snapshot.syncProgress.totalRepositories}`} repositories checked.</p> : null}
      {timedOut ? <p className="queue-message queue-message--info">Background sync continues. Last known progress: {snapshot.syncProgress.completedRepositories}{snapshot.syncProgress.totalRepositories === null ? "" : ` / ${snapshot.syncProgress.totalRepositories}`} repositories checked.</p> : null}
      {error && (snapshot.syncProgress.phase === "running" || snapshot.syncProgress.phase === "queued") ? <p className="queue-message queue-message--info">Last known progress: {snapshot.syncProgress.completedRepositories}{snapshot.syncProgress.totalRepositories === null ? "" : ` / ${snapshot.syncProgress.totalRepositories}`} repositories checked.</p> : null}
      {snapshot.syncProgress.retryAt ? <p className="queue-message queue-message--warning">Sync will retry at {snapshot.syncProgress.retryAt}.</p> : null}
      {snapshot.syncProgress.phase === "failed" || snapshot.syncProgress.phase === "stalled" ? <p className="queue-message queue-message--warning" role="alert">Sync {snapshot.syncProgress.phase}. Showing the last available data.</p> : null}
      {!snapshot.membershipComplete || (snapshot.status !== "complete" && !snapshot.enrichmentPending) || (!snapshot.classificationComplete && !snapshot.enrichmentPending) ? <p className="queue-message queue-message--info">Partial coverage: {snapshot.coveredRepositoryIds.length} repositories covered. Some status information may be unknown.{snapshot.unavailableRepositoryIds.length ? ` Unavailable: ${snapshot.unavailableRepositoryIds.map((id) => { const repo = snapshot.repositories.find(({ repository }) => repository.externalId === id); return repo ? `${repo.repository.owner}/${repo.repository.name}` : id; }).join(", ")}.` : ""}</p> : null}
      <div className="queue-filters"><label>Search pull requests<input value={filters.query} onChange={(e) => setFilters({ ...filters, query: e.target.value })} /></label><label>Search people<input value={personQuery} onChange={(e) => setPersonQuery(e.target.value)} /></label><label>Person<select value={filters.personId ?? ""} onChange={(e) => setFilters({ ...filters, personId: e.target.value || null })}><option value="">Everyone</option>{view?.persons.filter((person) => person.id === filters.personId || person.login.toLowerCase().includes(personQuery.toLowerCase())).map((person) => <option key={person.id} value={person.id}>{person.login}</option>)}</select></label>
      <label>Repository<select value={filters.repositoryIds[0] ?? ""} onChange={(e) => setFilters({ ...filters, repositoryIds: e.target.value ? [e.target.value] : [] })}><option value="">All repositories</option>{snapshot.repositories.map(({ repository }) => <option key={`${repository.provider}:${repository.externalId}`} value={repository.externalId}>{repository.owner}/{repository.name}</option>)}</select></label><label>Group<select value={filters.group ?? ""} onChange={(e) => setFilters({ ...filters, group: (e.target.value || null) as QueueGroup | null })}><option value="">All groups</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Sort<select value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value as PullRequestQueueFilters["sort"] })}><option value="activity">Last activity</option><option value="created">Newest created</option><option value="risk">Highest risk</option></select></label></div>
      {view?.filteredCount === 0 ? filtered ? <p>No pull requests match these filters. <button type="button" onClick={() => { setFilters(initial); setPersonQuery(""); }}>Clear filters</button></p> : snapshot.membershipComplete && snapshot.totalOpen === 0 ? <p>No open pull requests.</p> : <p>No pull requests available in this snapshot.</p> : view?.groups.map(({ group, items }) => items.length ? <section className="queue-group" key={group}><h3>{labels[group]} <span>{items.length}</span></h3>{items.slice(0, limits[group] ?? 50).map((item) => { const pull = item.pullRequest; const owners = [...item.attention.actorIds.map((id) => pull.author.id === id ? pull.author.login : pull.requestedUsers.find((person) => person.id === id)?.login ?? id), ...item.attention.teamIds.map((id) => pull.requestedTeams.find((team) => team.id === id)?.name ?? id)]; return <div className="queue-row" key={`${pull.repository.provider}:${pull.repository.externalId}:${pull.number}`}><div><button type="button" className="queue-title" onClick={(event) => setSelected({ key: queuePullRequestKey(pull.repository, pull.number), trigger: event.currentTarget })}>{pull.title}</button><p>{pull.repository.owner}/{pull.repository.name} #{pull.number} · {pull.author.login}{filters.personId ? matchedQueueRoles(pull, filters.personId).map((role) => <span className="queue-role" key={role}>{role}</span>) : null}</p></div><div><span className="queue-badge">{badges[item.attention.badge]}</span><p>{item.attention.reason}</p><p>Next action: {owners.join(", ") || "Unspecified"}</p></div><div><p>{item.assessment?.mode === "shadow" ? "Projected risk" : "Risk"}: {item.assessment?.riskTier ?? "Unknown"}{item.attention.assessmentStatus === "historical" ? " (historical)" : ""}</p><p>Human approvals: {item.attention.approvedCount ?? "Unknown"} / {item.attention.requiredCount ?? "Unknown"}</p><p>Last activity: {pull.updatedAt}</p></div></div>; })}{items.length > (limits[group] ?? 50) ? <button type="button" onClick={() => setLimits({ ...limits, [group]: (limits[group] ?? 50) + 50 })}>Show more</button> : null}</section> : null)}
    </> : null}{selected && selectedItem ? <PullRequestDetails item={selectedItem} returnFocusTo={selected.trigger} onClose={() => setSelected(null)} /> : null}</section>;
}
