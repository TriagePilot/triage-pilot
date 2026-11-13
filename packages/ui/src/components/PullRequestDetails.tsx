import { useEffect, useRef } from "react";
import type { QueueItem } from "@triagepilot/contracts";

export interface PullRequestDetailsProps { item: QueueItem; onClose(): void; returnFocusTo: HTMLElement | null }
export function PullRequestDetails({ item, onClose, returnFocusTo }: PullRequestDetailsProps): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { returnFocusTo?.focus(); };
  }, [returnFocusTo]);
  const { pullRequest: pull, attention, assessment, reviewState } = item;
  const names = [...pull.requestedUsers.map((person) => `${person.login} (${person.id})`), ...pull.requestedTeams.map((team) => `${team.name} (${team.id})`)];
  const ownerNames = [...attention.actorIds.map((id) => pull.author.id === id ? pull.author.login : pull.requestedUsers.find((person) => person.id === id)?.login ?? id), ...attention.teamIds.map((id) => pull.requestedTeams.find((team) => team.id === id)?.name ?? id)];
  return <div className="queue-dialog-backdrop"><div className="queue-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby="queue-details-title" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); close.current(); }
    if (event.key === "Tab") { const elements = [...(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]; if (!elements.length) { event.preventDefault(); return; } const first = elements[0], last = elements[elements.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}>
    <button type="button" onClick={onClose}>Close</button><h2 id="queue-details-title">{pull.title}</h2>
    <p>{pull.repository.owner}/{pull.repository.name} #{pull.number} · Author: {pull.author.login}</p>
    <p>{attention.reason}</p><p>Next action: {ownerNames.length ? ownerNames.join(", ") : "Unspecified"}</p>
    {attention.secondaryReasons.map((reason, index) => <p key={index}>{reason}</p>)}
    <p>Approvals: {attention.approvedCount === null ? "Unknown" : attention.approvedCount} / {attention.requiredCount === null ? "Unknown" : attention.requiredCount}</p>
    <p>Requested reviewers: {names.length ? names.join(", ") : "None"}</p>
    <p>Review evidence: {reviewState.status} · {reviewState.observedAt ?? "Observation unavailable"}</p>
    {reviewState.reviews.map((review) => <p key={review.id}>{review.actor.login}: {review.state} · {review.submittedAt ?? "Time unknown"}</p>)}
    <p>Assessment: {attention.assessmentStatus}</p>
    {assessment ? <><p>Decision: {assessment.decisionId} · {assessment.createdAt}</p><p>{assessment.mode === "shadow" ? "Projected risk" : "Risk"}: {assessment.riskTier ?? "Unknown"} · Policy check: {assessment.policyCheckState}</p><p>Action: {assessment.action} · {assessment.actionStatus}{assessment.failureReason ? ` · ${assessment.failureReason}` : ""}</p><p>Selected actors: {assessment.selectedActors.join(", ") || "None"}</p></> : <p>Risk: Unknown</p>}
    {attention.checkUpdatePending ? <p>Policy check update pending.</p> : null}
    <p>Created: {pull.createdAt} · Last activity: {pull.updatedAt}</p><p><a href={item.links.provider}>Open pull request</a>{item.links.decision ? <> · <a href={item.links.decision}>View routing decisions</a></> : null}</p>
  </div></div>;
}
