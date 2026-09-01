import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildReviewerAbsenceActivationKey,
  buildRoutingKey,
  type ConfigurationSource,
  type DecisionEventV1,
  type NormalizedChangeRequestEvent,
  type PlatformEventSink,
  type PlatformEventV1,
  type ReviewerAbsenceActivationJobPayload,
  type ReviewerReplacementEventV1,
  type TriagePilotJobPayload,
} from "../src/index";

describe("public platform contracts", () => {
  it("builds a provider-qualified ready routing key", () => {
    expect(buildRoutingKey({
      workspaceId: "ws_local",
      provider: "github",
      repositoryId: "200",
      changeRequestId: "7",
      trustedConfigRevision: "base-sha",
      headRevision: "head-sha",
      isDraft: false,
    })).toBe("routing:ws_local:github:200:7:base-sha:head-sha:ready");
  });

  it("distinguishes draft and ready routing keys while keeping retries stable", () => {
    const routingInput = {
      workspaceId: "ws_local",
      provider: "github" as const,
      repositoryId: "200",
      changeRequestId: "7",
      trustedConfigRevision: "base-sha",
      headRevision: "head-sha",
    };

    expect(buildRoutingKey({ ...routingInput, isDraft: true }))
      .toBe("routing:ws_local:github:200:7:base-sha:head-sha:draft");
    expect(buildRoutingKey({ ...routingInput, isDraft: true }))
      .toBe("routing:ws_local:github:200:7:base-sha:head-sha:draft");
    expect(buildRoutingKey({ ...routingInput, isDraft: false }))
      .toBe("routing:ws_local:github:200:7:base-sha:head-sha:ready");
    expect(buildRoutingKey({ ...routingInput, isDraft: false }))
      .toBe("routing:ws_local:github:200:7:base-sha:head-sha:ready");
  });

  it("keeps events and configuration sources provider neutral", () => {
    expectTypeOf<NormalizedChangeRequestEvent["provider"]>().toEqualTypeOf<"github" | "gitlab" | "bitbucket">();
    expectTypeOf<ConfigurationSource["loadOrganization"]>().toBeFunction();
    expectTypeOf<DecisionEventV1["schemaVersion"]>().toEqualTypeOf<1>();
  });

  it("exposes a discriminated platform event union", () => {
    expectTypeOf<DecisionEventV1["eventType"]>().toEqualTypeOf<"routing_decision">();
    expectTypeOf<ReviewerReplacementEventV1["eventType"]>().toEqualTypeOf<"reviewer_replacement">();
    expectTypeOf<Extract<PlatformEventV1, { eventType: "routing_decision" }>>()
      .toEqualTypeOf<DecisionEventV1>();
    expectTypeOf<Extract<PlatformEventV1, { eventType: "reviewer_replacement" }>>()
      .toEqualTypeOf<ReviewerReplacementEventV1>();
    expectTypeOf<PlatformEventSink["emit"]>().parameter(0).toEqualTypeOf<PlatformEventV1>();
  });

  it("keeps reviewer absence activation jobs workspace and connection scoped", () => {
    const payload: ReviewerAbsenceActivationJobPayload = {
      kind: "activate_reviewer_absence",
      workspaceId: "ws_local",
      providerConnectionId: "connection-17",
      absenceId: "absence-42",
      absenceRevision: 3,
    };
    const job: TriagePilotJobPayload = payload;

    expect(job).toEqual(payload);
  });

  it("builds a revision-specific reviewer absence activation key", () => {
    expect(buildReviewerAbsenceActivationKey("absence-42", 3))
      .toBe("reviewer-absence:absence-42:revision:3");
  });
});
