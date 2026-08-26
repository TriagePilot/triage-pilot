import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AvailabilityOverview, ReviewerAbsenceView } from "@triagepilot/db";

import {
  AdminApiError,
  cancelAbsence,
  createAbsence,
  updateAbsence,
  updateAvailabilityTimezone,
  type AbsenceFormInput,
} from "./api";

interface AvailabilityPanelProps {
  availability: AvailabilityOverview;
  onChange(availability: AvailabilityOverview): void;
  onSessionExpired?: ((message: string) => void) | undefined;
}

const emptyAbsence: AbsenceFormInput = {
  reviewerHandle: "",
  startLocal: "",
  endLocal: "",
};

export function AvailabilityPanel({ availability, onChange, onSessionExpired }: AvailabilityPanelProps) {
  const [timezone, setTimezone] = useState(availability.timezone);
  const [form, setForm] = useState<AbsenceFormInput>(emptyAbsence);
  const [editing, setEditing] = useState<ReviewerAbsenceView | null>(null);
  const [pending, setPending] = useState<"timezone" | "absence" | string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutationInFlight = useRef(false);

  useEffect(() => {
    setTimezone(availability.timezone);
    if (editing) {
      setForm({
        reviewerHandle: editing.reviewerHandle,
        startLocal: toLocalDateTime(editing.startAt, availability.timezone),
        endLocal: toLocalDateTime(editing.endAt, availability.timezone),
      });
    }
  }, [availability.timezone, editing]);

  async function submitTimezone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate("timezone", () => updateAvailabilityTimezone(timezone));
  }

  async function submitAbsence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = editing;
    const saved = await mutate("absence", async () => {
      if (current) return updateAbsence(current.id, { ...form, expectedRevision: current.revision });
      return createAbsence(form);
    });
    if (saved) {
      setForm(emptyAbsence);
      setEditing(null);
    }
  }

  async function confirmCancellation(absence: ReviewerAbsenceView) {
    await mutate(absence.id, () => cancelAbsence(absence.id, absence.revision));
    setCancelling(null);
  }

  async function mutate(key: "timezone" | "absence" | string, action: () => Promise<AvailabilityOverview>) {
    if (mutationInFlight.current) return false;
    mutationInFlight.current = true;
    setError(null);
    setPending(key);
    try {
      onChange(await action());
      return true;
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired?.(caught.message);
        return false;
      }
      setError(messageFrom(caught));
      return false;
    } finally {
      mutationInFlight.current = false;
      setPending(null);
    }
  }

  function beginEdit(absence: ReviewerAbsenceView) {
    setError(null);
    setCancelling(null);
    setEditing(absence);
    setForm({
      reviewerHandle: absence.reviewerHandle,
      startLocal: toLocalDateTime(absence.startAt, availability.timezone),
      endLocal: toLocalDateTime(absence.endAt, availability.timezone),
    });
  }

  function resetAbsenceForm() {
    setEditing(null);
    setForm(emptyAbsence);
  }

  const busy = pending !== null;

  return (
    <section className="availability-grid">
      <div className="availability-intro">
        <p className="eyebrow">Reviewer routing</p>
        <h2 id="availability-heading">Reviewer availability</h2>
        <p>Set the organization timezone, then record individual reviewer absences in local wall time.</p>
      </div>

      {error ? <p role="alert" className="notice notice--danger">{error}</p> : null}

      <form className="availability-form" onSubmit={(event) => void submitTimezone(event)}>
        <label htmlFor="availability-timezone">Organization timezone</label>
        <input
          id="availability-timezone"
          name="timezone"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          aria-describedby="availability-timezone-help"
          required
          disabled={busy}
        />
        <small id="availability-timezone-help">Use an IANA timezone, for example Europe/Bratislava.</small>
        <button type="submit" disabled={busy}>{pending === "timezone" ? "Saving…" : "Save timezone"}</button>
      </form>

      <form className="availability-form" onSubmit={(event) => void submitAbsence(event)}>
        <h3>{editing ? `Edit absence for ${editing.reviewerHandle}` : "Record reviewer absence"}</h3>
        <label htmlFor="absence-reviewer-handle">Individual GitHub handle</label>
        <input
          id="absence-reviewer-handle"
          name="reviewerHandle"
          value={form.reviewerHandle}
          onChange={(event) => setForm({ ...form, reviewerHandle: event.target.value })}
          placeholder="@user-d82a5f"
          required
          disabled={busy}
        />
        <label htmlFor="absence-start">Start ({availability.timezone})</label>
        <input
          id="absence-start"
          name="startLocal"
          type="datetime-local"
          value={form.startLocal}
          onChange={(event) => setForm({ ...form, startLocal: event.target.value })}
          required
          disabled={busy}
        />
        <label htmlFor="absence-end">End ({availability.timezone})</label>
        <input
          id="absence-end"
          name="endLocal"
          type="datetime-local"
          value={form.endLocal}
          onChange={(event) => setForm({ ...form, endLocal: event.target.value })}
          required
          disabled={busy}
        />
        <div className="availability-form__actions">
          <button type="submit" disabled={busy}>
            {pending === "absence" ? "Saving…" : editing ? "Save absence" : "Add absence"}
          </button>
          {editing ? <button className="button--quiet" type="button" onClick={resetAbsenceForm} disabled={busy}>Discard edit</button> : null}
        </div>
      </form>

      <div className="availability-history table-scroll" role="region" tabIndex={0} aria-labelledby="availability-history-heading">
        <h3 id="availability-history-heading">Absence history</h3>
        <table>
          <caption className="sr-only">Reviewer absences</caption>
          <thead>
            <tr>
              <th scope="col">Reviewer</th>
              <th scope="col">Window</th>
              <th scope="col">Status</th>
              <th scope="col">Replacement history</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {availability.absences.length === 0 ? (
              <tr><td className="empty-cell" colSpan={5}>No reviewer absences are recorded.</td></tr>
            ) : availability.absences.map((absence) => {
              const mutable = absence.status !== "cancelled" && absence.status !== "ended";
              const isCancelling = cancelling === absence.id;
              return (
                <tr key={absence.id}>
                  <th scope="row" className="data-text">{absence.reviewerHandle}</th>
                  <td>
                    <time dateTime={absence.startAt}>{formatDate(absence.startAt, availability.timezone)}</time>
                    <span className="cell-detail">to <time dateTime={absence.endAt}>{formatDate(absence.endAt, availability.timezone)}</time></span>
                  </td>
                  <td><StatusChip status={absence.status} /></td>
                  <td><ReplacementHistory absence={absence} /></td>
                  <td>
                    {mutable ? (
                      <div className="availability-actions">
                        <button className="button--quiet" type="button" onClick={() => beginEdit(absence)} disabled={busy}>Edit</button>
                        {isCancelling ? (
                          <>
                            <span className="cell-detail">Cancel this absence?</span>
                            <button type="button" onClick={() => void confirmCancellation(absence)} disabled={busy}>Confirm cancel</button>
                            <button className="button--quiet" type="button" onClick={() => setCancelling(null)} disabled={busy}>Keep</button>
                          </>
                        ) : <button type="button" onClick={() => setCancelling(absence.id)} disabled={busy}>Cancel</button>}
                      </div>
                    ) : <span className="cell-detail">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReplacementHistory({ absence }: { absence: ReviewerAbsenceView }) {
  if (absence.replacements.length === 0) return <span className="cell-detail">No replacement outcomes recorded.</span>;
  return (
    <ul className="replacement-list">
      {absence.replacements.map((replacement) => (
        <li key={replacement.id}>
          <a href={`https://github.com/${replacement.repository}/pull/${replacement.pullNumber}`} target="_blank" rel="noreferrer">
            {replacement.repository} #{replacement.pullNumber}
          </a>
          <span className="cell-detail">
            {replacement.replacementReviewer ?? "No replacement"} · {labelFor(replacement.outcome)} · {replacement.reason}
          </span>
          {replacement.outcome === "no_replacement_available" ? <span className="cell-detail">No replacement was available; the required review count was unchanged.</span> : null}
        </li>
      ))}
    </ul>
  );
}

function StatusChip({ status }: { status: ReviewerAbsenceView["status"] }) {
  return <span className={`chip chip--${status}`}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

function formatDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}

function toLocalDateTime(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
}

function labelFor(value: string): string {
  return value.replaceAll("_", " ");
}

function messageFrom(caught: unknown): string {
  return caught instanceof AdminApiError ? caught.message : "Could not update reviewer availability.";
}
