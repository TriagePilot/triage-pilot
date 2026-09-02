import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  AuthorizationCapabilities,
  AvailabilitySettingsOverview,
  OperationsApiClient,
  ReviewerAbsenceMutation,
  ReviewerAbsenceOverview,
  ReviewerReplacementOverview,
  WorkspaceContext,
} from "../api.js";

export interface ReviewerAvailabilityProps {
  api: OperationsApiClient;
  workspace: WorkspaceContext;
  authorization: AuthorizationCapabilities;
  initialSettings?: AvailabilitySettingsOverview;
  initialAbsences?: ReviewerAbsenceOverview[];
  initialReplacementHistory?: ReviewerReplacementOverview[];
  onUnauthorized?(message: string): void;
}

const emptyForm: ReviewerAbsenceMutation = { externalActorId: "", startLocal: "", endLocal: "" };

export function ReviewerAvailability({
  api,
  workspace,
  authorization,
  initialSettings,
  initialAbsences,
  initialReplacementHistory,
  onUnauthorized,
}: ReviewerAvailabilityProps) {
  const [settings, setSettings] = useState(initialSettings ?? null);
  const [timezone, setTimezone] = useState(initialSettings?.timezone ?? "UTC");
  const [absences, setAbsences] = useState(initialAbsences ?? []);
  const [history, setHistory] = useState(initialReplacementHistory ?? []);
  const [form, setForm] = useState<ReviewerAbsenceMutation>(emptyForm);
  const [editing, setEditing] = useState<ReviewerAbsenceOverview | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [loading, setLoading] = useState(initialSettings === undefined || initialAbsences === undefined || initialReplacementHistory === undefined);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutationInFlight = useRef(false);

  useEffect(() => {
    if (!authorization.canViewOperations) return;
    if (initialSettings !== undefined && initialAbsences !== undefined && initialReplacementHistory !== undefined) return;
    let current = true;
    setLoading(true);
    void Promise.all([
      api.readAvailabilitySettings(workspace),
      api.listReviewerAbsences(workspace),
      api.listReviewerReplacementHistory(workspace),
    ]).then(([nextSettings, nextAbsences, nextHistory]) => {
      if (!current) return;
      setSettings(nextSettings);
      setTimezone(nextSettings.timezone);
      setAbsences(nextAbsences);
      setHistory(nextHistory);
      setError(null);
    }).catch((caught: unknown) => handleError(caught, onUnauthorized, setError)).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [api, workspace, authorization.canViewOperations, initialSettings, initialAbsences, initialReplacementHistory, onUnauthorized]);

  if (!authorization.canViewOperations) {
    return <section className="availability-grid"><p>You are not authorized to view reviewer availability.</p></section>;
  }
  if (loading || settings === null) {
    return <section className="availability-grid" aria-live="polite"><p>Loading reviewer availability…</p></section>;
  }

  const busy = pending !== null;

  async function mutate(key: string, action: () => Promise<void>): Promise<boolean> {
    if (mutationInFlight.current) return false;
    mutationInFlight.current = true;
    setPending(key);
    setError(null);
    try {
      await action();
      return true;
    } catch (caught) {
      handleError(caught, onUnauthorized, setError);
      return false;
    } finally {
      mutationInFlight.current = false;
      setPending(null);
    }
  }

  async function submitTimezone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate("timezone", async () => {
      const next = await api.updateAvailabilityTimezone(workspace, timezone);
      setSettings(next);
    });
  }

  async function submitAbsence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = editing;
    const saved = await mutate("absence", async () => {
      const next = current
        ? await api.reviseReviewerAbsence(workspace, current.id, { ...form, expectedRevision: current.revision })
        : await api.scheduleReviewerAbsence(workspace, form);
      setAbsences((items) => [next, ...items.filter((item) => item.id !== next.id)]);
    });
    if (saved) {
      setEditing(null);
      setForm(emptyForm);
    }
  }

  async function confirmCancellation(absence: ReviewerAbsenceOverview) {
    const saved = await mutate(absence.id, async () => {
      const next = await api.cancelReviewerAbsence(workspace, absence.id, absence.revision);
      setAbsences((items) => items.map((item) => item.id === next.id ? next : item));
    });
    if (saved) setCancelling(null);
  }

  function beginEdit(absence: ReviewerAbsenceOverview) {
    setEditing(absence);
    setCancelling(null);
    setError(null);
    setForm({
      externalActorId: absence.externalActorId,
      startLocal: toLocalDateTime(absence.startAt, settings!.timezone),
      endLocal: toLocalDateTime(absence.endAt, settings!.timezone),
    });
  }

  return (
    <section className="availability-grid">
      <div className="availability-intro">
        <p className="eyebrow">Reviewer routing</p>
        <h2 id="availability-heading">Reviewer availability</h2>
        <p>Schedule individual reviewer absences in the workspace timezone.</p>
      </div>
      {error ? <p role="alert" className="notice notice--danger">{error}</p> : null}

      {authorization.canManageReviewerAvailability ? (
        <>
          <form className="availability-form" onSubmit={(event) => void submitTimezone(event)}>
            <label htmlFor="availability-timezone">Workspace timezone</label>
            <input id="availability-timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} disabled={busy} required />
            <small>Use an IANA timezone, for example Europe/Bratislava.</small>
            <button type="submit" disabled={busy}>{pending === "timezone" ? "Saving…" : "Save timezone"}</button>
          </form>
          <form className="availability-form" onSubmit={(event) => void submitAbsence(event)}>
            <h3>{editing ? `Edit absence for ${editing.externalActorId}` : "Record reviewer absence"}</h3>
            <label htmlFor="absence-actor">External actor ID</label>
            <input id="absence-actor" value={form.externalActorId} onChange={(event) => setForm({ ...form, externalActorId: event.target.value })} disabled={busy} required />
            <label htmlFor="absence-start">Start ({settings.timezone})</label>
            <input id="absence-start" type="datetime-local" value={form.startLocal} onChange={(event) => setForm({ ...form, startLocal: event.target.value })} disabled={busy} required />
            <label htmlFor="absence-start-offset">Start UTC offset (only for ambiguous times)</label>
            <input id="absence-start-offset" placeholder="+02:00" value={form.startUtcOffset ?? ""} onChange={(event) => setForm(withOptionalOffset(form, "startUtcOffset", event.target.value))} disabled={busy} />
            <label htmlFor="absence-end">End ({settings.timezone})</label>
            <input id="absence-end" type="datetime-local" value={form.endLocal} onChange={(event) => setForm({ ...form, endLocal: event.target.value })} disabled={busy} required />
            <label htmlFor="absence-end-offset">End UTC offset (only for ambiguous times)</label>
            <input id="absence-end-offset" placeholder="+01:00" value={form.endUtcOffset ?? ""} onChange={(event) => setForm(withOptionalOffset(form, "endUtcOffset", event.target.value))} disabled={busy} />
            <div className="availability-form__actions">
              <button type="submit" disabled={busy}>{pending === "absence" ? "Saving…" : editing ? "Save absence" : "Add absence"}</button>
              {editing ? <button type="button" className="button--quiet" disabled={busy} onClick={() => { setEditing(null); setForm(emptyForm); }}>Discard edit</button> : null}
            </div>
          </form>
        </>
      ) : <p className="cell-detail">Timezone: {settings.timezone}. Availability is read-only.</p>}

      <div className="availability-history table-scroll" role="region" tabIndex={0} aria-labelledby="availability-history-heading">
        <h3 id="availability-history-heading">Absence history</h3>
        <table>
          <caption className="sr-only">Reviewer absences</caption>
          <thead><tr><th scope="col">Reviewer</th><th scope="col">Window</th><th scope="col">Status</th><th scope="col">Replacement history</th><th scope="col">Actions</th></tr></thead>
          <tbody>{absences.length === 0 ? <tr><td colSpan={5} className="empty-cell">No reviewer absences are recorded.</td></tr> : absences.map((absence) => {
            const replacements = history.filter((item) => item.absenceId === absence.id);
            const mutable = absence.status === "active" || absence.status === "upcoming";
            return <tr key={absence.id}>
              <th scope="row" className="data-text">{absence.externalActorId}</th>
              <td><time dateTime={absence.startAt}>{formatDate(absence.startAt, settings.timezone)}</time><span className="cell-detail">to <time dateTime={absence.endAt}>{formatDate(absence.endAt, settings.timezone)}</time></span></td>
              <td><span className={`chip chip--${absence.status}`}>{capitalize(absence.status)}</span></td>
              <td>{replacements.length === 0 ? <span className="cell-detail">No replacement outcomes recorded.</span> : <ul className="replacement-list">{replacements.map((item) => <li key={item.id}><span className="data-text">{item.replacementActorId ?? "No replacement"}</span><span className="cell-detail">{item.outcome.replaceAll("_", " ")} · {item.reason}</span>{item.lastError ? <span className="cell-error">{item.lastError}</span> : null}</li>)}</ul>}</td>
              <td>{authorization.canManageReviewerAvailability && mutable ? <div className="availability-actions">
                <button type="button" className="button--quiet" disabled={busy} onClick={() => beginEdit(absence)}>Edit</button>
                {cancelling === absence.id ? <><span className="cell-detail">Cancel this absence?</span><button type="button" disabled={busy} onClick={() => void confirmCancellation(absence)}>Confirm cancel</button><button type="button" className="button--quiet" disabled={busy} onClick={() => setCancelling(null)}>Keep</button></> : <button type="button" disabled={busy} onClick={() => setCancelling(absence.id)}>Cancel</button>}
              </div> : <span className="cell-detail">—</span>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </section>
  );
}

function handleError(caught: unknown, onUnauthorized: ((message: string) => void) | undefined, setError: (message: string) => void) {
  const message = caught instanceof Error ? caught.message : "Could not update reviewer availability.";
  if (typeof caught === "object" && caught !== null && "status" in caught && caught.status === 401) {
    onUnauthorized?.(message);
    return;
  }
  setError(message);
}

function formatDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value));
}

function toLocalDateTime(value: string, timezone: string): string {
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function withOptionalOffset(
  form: ReviewerAbsenceMutation,
  field: "startUtcOffset" | "endUtcOffset",
  value: string,
): ReviewerAbsenceMutation {
  const next = { ...form };
  if (value === "") delete next[field];
  else next[field] = value;
  return next;
}
