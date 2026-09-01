import { describe, expect, it } from "vitest";

import { availableActorsAt, selectReplacement } from "../src/availability";

describe("availableActorsAt", () => {
  it("treats absence intervals as start-inclusive and end-exclusive", () => {
    const startAt = new Date("2026-09-01T09:00:00.000Z");
    const endAt = new Date("2026-09-01T17:00:00.000Z");
    const input = {
      actors: ["@user-a91f5c"],
      absences: [{ externalActorId: "@user-a91f5c", startAt, endAt }],
    };

    expect(availableActorsAt({ ...input, now: startAt })).toEqual([]);
    expect(availableActorsAt({ ...input, now: endAt })).toEqual(["@user-a91f5c"]);
  });

  it("normalizes and deduplicates actors before filtering simultaneous absences", () => {
    expect(
      availableActorsAt({
        actors: [" USER-A91F5C ", "@user-b4e82d", "@USER-A91F5C", "user-c63a18"],
        absences: [
          {
            externalActorId: "@User-A91F5C",
            startAt: new Date("2026-09-01T08:00:00.000Z"),
            endAt: new Date("2026-09-01T12:00:00.000Z"),
          },
          {
            externalActorId: " user-b4e82d ",
            startAt: new Date("2026-09-01T09:00:00.000Z"),
            endAt: new Date("2026-09-01T11:00:00.000Z"),
          },
          {
            externalActorId: "@user-c63a18",
            startAt: new Date("2026-09-01T11:00:00.000Z"),
            endAt: new Date("2026-09-01T13:00:00.000Z"),
          },
        ],
        now: new Date("2026-09-01T10:00:00.000Z"),
      }),
    ).toEqual(["@user-c63a18"]);
  });
});

describe("selectReplacement", () => {
  it("normalizes identities and excludes the author, unavailable actor, approvers, active cohort, and absent actors", () => {
    expect(
      selectReplacement({
        author: " User-C91E46 ",
        unavailableActor: "USER-4D8A2E",
        activeCohort: [" USER-7C1F9B "],
        approvedActors: ["User-A91F5C"],
        originalEligibleActors: [
          "@USER-C91E46",
          "@user-4d8a2e",
          "user-7c1f9b",
          "@USER-A91F5C",
          "User-B4E82D",
          "@user-c63a18",
        ],
        originalPreferredActors: ["@user-b4e82d", "@user-c63a18"],
        absences: [
          {
            externalActorId: " USER-B4E82D ",
            startAt: new Date("2026-09-01T09:00:00.000Z"),
            endAt: new Date("2026-09-01T11:00:00.000Z"),
          },
        ],
        load: { "@user-c63a18": 0 },
        selectionKey: "acme/api#21",
        now: new Date("2026-09-01T10:00:00.000Z"),
      }),
    ).toEqual({
      replacementActor: "@user-c63a18",
      candidates: ["@user-c63a18"],
    });
  });

  it("selects an available preferred actor before a lower-load fallback", () => {
    expect(
      selectReplacement({
        author: "@user-c91e46",
        unavailableActor: "@user-4d8a2e",
        activeCohort: ["@user-4d8a2e"],
        approvedActors: [],
        originalEligibleActors: ["@user-5c9f21", "@user-b4e82d"],
        originalPreferredActors: [" USER-B4E82D "],
        absences: [],
        load: { "@user-5c9f21": 0, "@user-b4e82d": 9 },
        selectionKey: "acme/api#22",
        now: new Date("2026-09-01T10:00:00.000Z"),
      }),
    ).toEqual({
      replacementActor: "@user-b4e82d",
      candidates: ["@user-5c9f21", "@user-b4e82d"],
    });
  });

  it("supplements an unavailable preferred tier with the lowest-load fallback", () => {
    expect(
      selectReplacement({
        author: "@user-c91e46",
        unavailableActor: "@user-4d8a2e",
        activeCohort: ["@user-4d8a2e"],
        approvedActors: [],
        originalEligibleActors: ["@user-b4e82d", "@user-5c9f21", "@user-f37a82"],
        originalPreferredActors: ["@user-b4e82d"],
        absences: [
          {
            externalActorId: "@user-b4e82d",
            startAt: new Date("2026-09-01T09:00:00.000Z"),
            endAt: new Date("2026-09-01T11:00:00.000Z"),
          },
        ],
        load: { "@user-5c9f21": 4, "@user-f37a82": 0 },
        selectionKey: "acme/api#23",
        now: new Date("2026-09-01T10:00:00.000Z"),
      }),
    ).toEqual({
      replacementActor: "@user-f37a82",
      candidates: ["@user-5c9f21", "@user-f37a82"],
    });
  });

  it("uses the existing stable rank when candidate loads tie", () => {
    const input = {
      author: "@user-c91e46",
      unavailableActor: "@user-4d8a2e",
      activeCohort: ["@user-4d8a2e"],
      approvedActors: [],
      originalEligibleActors: ["@user-a91f5c", "@user-2e7d4b", "@user-c63a18"],
      originalPreferredActors: [],
      absences: [],
      load: { "@user-a91f5c": 0, "@user-2e7d4b": 0, "@user-c63a18": 0 },
      selectionKey: "acme/api#8",
      now: new Date("2026-09-01T10:00:00.000Z"),
    };

    expect(selectReplacement(input)).toEqual({
      replacementActor: "@user-c63a18",
      candidates: ["@user-2e7d4b", "@user-a91f5c", "@user-c63a18"],
    });
    expect(selectReplacement(input).replacementActor).toBe("@user-c63a18");
  });

  it("returns no replacement when every original candidate is excluded", () => {
    expect(
      selectReplacement({
        author: "@user-c91e46",
        unavailableActor: "@user-4d8a2e",
        activeCohort: ["@user-7c1f9b"],
        approvedActors: ["@user-a91f5c"],
        originalEligibleActors: ["@user-c91e46", "@user-4d8a2e", "@user-7c1f9b", "@user-a91f5c"],
        originalPreferredActors: ["@user-4d8a2e"],
        absences: [],
        load: {},
        selectionKey: "acme/api#24",
        now: new Date("2026-09-01T10:00:00.000Z"),
      }),
    ).toEqual({ replacementActor: null, candidates: [] });
  });
});
