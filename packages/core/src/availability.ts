import { selectLowestLoadReviewers } from "./routing";

export interface AvailabilityWindow {
  reviewerHandle: string;
  startAt: Date;
  endAt: Date;
}

export interface AvailabilityReplacementSelection {
  candidates: string[];
  replacementReviewer: string | null;
}

export function availableReviewerHandlesAt(input: {
  reviewers: string[];
  absences: AvailabilityWindow[];
  now: Date;
}): string[] {
  const unavailableReviewers = new Set(
    input.absences
      .filter((absence) => absence.startAt <= input.now && input.now < absence.endAt)
      .map((absence) => normalizeReviewer(absence.reviewerHandle))
      .filter(Boolean),
  );
  return uniqueReviewers(input.reviewers).filter((reviewer) => !unavailableReviewers.has(reviewer));
}

export function selectAvailabilityReplacement(input: {
  originalEligibleReviewers: string[];
  originalPreferredReviewers?: string[];
  unavailableReviewer: string;
  author: string;
  approvedReviewers: string[];
  currentReviewers: string[];
  absences: AvailabilityWindow[];
  now: Date;
  load: Record<string, number>;
  selectionKey: string;
}): AvailabilityReplacementSelection {
  const unavailableReviewer = normalizeReviewer(input.unavailableReviewer);
  const author = normalizeReviewer(input.author);
  const approvedReviewers = new Set(uniqueReviewers(input.approvedReviewers));
  const currentReviewers = new Set(uniqueReviewers(input.currentReviewers));
  const candidates = availableReviewerHandlesAt({
    reviewers: input.originalEligibleReviewers,
    absences: input.absences,
    now: input.now,
  })
    .filter((reviewer) => reviewer !== unavailableReviewer && reviewer !== author)
    .filter((reviewer) => !approvedReviewers.has(reviewer) && !currentReviewers.has(reviewer))
    .sort();
  const preferredReviewerSet = new Set(uniqueReviewers(
    input.originalPreferredReviewers ?? input.originalEligibleReviewers,
  ));
  const preferredCandidates = candidates.filter((reviewer) => preferredReviewerSet.has(reviewer));
  const fallbackCandidates = candidates.filter((reviewer) => !preferredReviewerSet.has(reviewer));
  const replacementReviewer =
    selectLowestLoadReviewers(preferredCandidates, input.load, input.selectionKey, 1)[0] ??
    selectLowestLoadReviewers(fallbackCandidates, input.load, input.selectionKey, 1)[0] ??
    null;

  return { candidates, replacementReviewer };
}

function uniqueReviewers(reviewers: string[]): string[] {
  return [...new Set(reviewers.map(normalizeReviewer).filter(Boolean))];
}

function normalizeReviewer(reviewer: string): string {
  const normalized = reviewer.trim().replace(/^@/, "").toLowerCase();
  return normalized ? `@${normalized}` : "";
}
