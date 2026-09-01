import { normalizeReviewer, selectLowestLoadReviewers, uniqueReviewers } from "./routing.js";

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
  const preferredActorSet = new Set(uniqueReviewers(input.originalPreferredActors));
  const preferredCandidates = candidates.filter((actor) => preferredActorSet.has(actor));
  const fallbackCandidates = candidates.filter((actor) => !preferredActorSet.has(actor));
  const replacementActor =
    selectLowestLoadReviewers(preferredCandidates, input.load, input.selectionKey, 1)[0] ??
    selectLowestLoadReviewers(fallbackCandidates, input.load, input.selectionKey, 1)[0] ??
    null;

  return { replacementActor, candidates };
}
