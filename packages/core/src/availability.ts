import { normalizeReviewer, selectTieredReviewers, uniqueReviewers } from "./reviewer-selection.js";

export interface ReviewerAbsenceWindow {
  externalActorId: string;
  startAt: Date;
  endAt: Date;
}

export function availableActorsAt(input: {
  actors: string[];
  absences: ReviewerAbsenceWindow[];
  now: Date;
}): string[] {
  const unavailableActors = new Set(
    input.absences
      .filter((absence) => absence.startAt <= input.now && input.now < absence.endAt)
      .map((absence) => normalizeReviewer(absence.externalActorId))
      .filter(Boolean),
  );

  return uniqueReviewers(input.actors).filter((actor) => !unavailableActors.has(actor));
}

export function selectReplacement(input: {
  author: string;
  unavailableActor: string;
  activeCohort: string[];
  approvedActors: string[];
  originalEligibleActors: string[];
  originalPreferredActors: string[];
  absences: ReviewerAbsenceWindow[];
  load: Record<string, number>;
  selectionKey: string;
  now: Date;
}): { replacementActor: string | null; candidates: string[] } {
  const excludedActors = new Set(uniqueReviewers([
    input.author,
    input.unavailableActor,
    ...input.activeCohort,
    ...input.approvedActors,
  ]));
  const candidates = availableActorsAt({
    actors: input.originalEligibleActors,
    absences: input.absences,
    now: input.now,
  })
    .filter((actor) => !excludedActors.has(actor))
    .sort();
  const replacementActor = selectTieredReviewers({
    candidates,
    preferredReviewers: input.originalPreferredActors,
    load: input.load,
    selectionKey: input.selectionKey,
    count: 1,
  })[0] ?? null;

  return { replacementActor, candidates };
}
