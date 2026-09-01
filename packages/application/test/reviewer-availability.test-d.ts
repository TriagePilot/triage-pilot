import { expectTypeOf } from "vitest";

import type {
  PersistReviewerReplacementInput,
  ReviewerMutationIntentId,
  ReviewerReplacementFinalizerRecord,
  ReviewerReplacementFinalizerRecovery,
} from "../src/reviewer-availability.js";

type ReplacedFinalizer = Extract<ReviewerReplacementFinalizerRecord, { outcome: "replaced" }>;
type ReplacedPersistence = Extract<PersistReviewerReplacementInput, { outcome: "replaced" }>;
type ReplacedRecovery = Extract<ReviewerReplacementFinalizerRecovery, { outcome: "replaced" }>;
type ProviderFailureRecovery = Extract<ReviewerReplacementFinalizerRecovery, { outcome: "permanent_failure" }>;
type NonMutationFinalizer = Extract<
  ReviewerReplacementFinalizerRecord,
  { outcome: "no_replacement_available" }
>;

expectTypeOf<ReplacedFinalizer["mutationIntentId"]>().toEqualTypeOf<ReviewerMutationIntentId>();
expectTypeOf<ReplacedFinalizer["replacementActorId"]>().toEqualTypeOf<string>();
expectTypeOf<ReplacedPersistence["mutationIntentId"]>().toEqualTypeOf<ReviewerMutationIntentId>();
expectTypeOf<ReplacedPersistence["replacementActorId"]>().toEqualTypeOf<string>();
expectTypeOf<ReplacedRecovery["mutationIntentId"]>().toEqualTypeOf<ReviewerMutationIntentId>();
expectTypeOf<ReplacedRecovery["replacementActorId"]>().toEqualTypeOf<string>();
expectTypeOf<ProviderFailureRecovery["mutationIntentId"]>().toEqualTypeOf<ReviewerMutationIntentId>();
expectTypeOf<ProviderFailureRecovery["providerEffectsApplied"]>().toEqualTypeOf<true>();
expectTypeOf<NonMutationFinalizer["replacementActorId"]>().toEqualTypeOf<null>();

expectTypeOf<{
  id: string;
  decisionId: string;
  replacementActorId: null;
  mutationIntentId: null;
  outcome: "replaced";
  state: "finalizer_pending";
}>().not.toMatchTypeOf<ReviewerReplacementFinalizerRecord>();

expectTypeOf<{
  provider: "github";
  providerConnectionId: string;
  absenceId: string;
  absenceRevision: number;
  decisionId: string;
  expectedHeadRevision: string;
  unavailableActorId: string;
  replacementActorId: null;
  mutationIntentId: null;
  outcome: "replaced";
  reason: string;
  state: "finalizer_pending";
  lastError: null;
  startedAt: Date;
  completedAt: Date;
  replaceCohort: true;
  event: {
    schemaVersion: 1;
    eventType: "reviewer_replacement";
    eventId: string;
    occurredAt: string;
    workspaceId: string;
    provider: "github";
    providerConnectionId: string;
    absenceId: string;
    absenceRevision: number;
    decisionId: string;
    repositoryId: string;
    changeRequestId: string;
    unavailableActor: string;
    replacementActor: null;
    outcome: "replaced";
  };
}>().not.toMatchTypeOf<PersistReviewerReplacementInput>();

expectTypeOf<{
  kind: "reviewer_replacement_finalizer";
  phase: "run_finalizer";
  job: {
    kind: "activate_reviewer_absence";
    workspaceId: string;
    providerConnectionId: string;
    absenceId: string;
    absenceRevision: number;
  };
  finalizer: {
    action: "reevaluate_policy";
    decisionId: string;
    summary: null;
  };
  replacementId: string;
  mutationIntentId: null;
  providerEffectsApplied: true;
  persistence: null;
  lastError: string;
}>().not.toMatchTypeOf<ReviewerReplacementFinalizerRecovery>();
