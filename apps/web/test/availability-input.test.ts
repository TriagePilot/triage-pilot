import { describe, expect, it } from "vitest";

import {
  AvailabilityInputError,
  parseAvailabilityMutation,
  parseTimezoneInput,
} from "../src/availability-input";

describe("availability input", () => {
  it("normalizes an external actor and converts local wall time through an IANA timezone", () => {
    expect(parseAvailabilityMutation({
      externalActorId: "  @User-D82A5F ",
      startLocal: "2026-03-28T09:00",
      endLocal: "2026-03-28T17:00",
      timezone: "Europe/Bratislava",
    })).toEqual({
      externalActorId: "@user-d82a5f",
      startAt: new Date("2026-03-28T08:00:00.000Z"),
      endAt: new Date("2026-03-28T16:00:00.000Z"),
    });
  });

  it.each([
    ["Europe/Not_A_Zone", "timezone", "Enter a valid IANA timezone."],
    ["Europe/Bratislava", "startLocal", "This local time does not exist in the selected timezone."],
  ] as const)("reports invalid timezone and nonexistent wall time by field", (timezone, field, message) => {
    expect(() => parseAvailabilityMutation({
      externalActorId: "@user-d82a5f",
      startLocal: field === "startLocal" ? "2026-03-29T02:30" : "2026-03-28T09:00",
      endLocal: "2026-03-28T17:00",
      timezone,
    })).toThrow(expect.objectContaining({ issues: [{ field, message }] }));
  });

  it("requires an explicit matching offset for an ambiguous fall-back wall time", () => {
    const input = {
      externalActorId: "@user-d82a5f",
      startLocal: "2026-10-25T02:30",
      endLocal: "2026-10-25T03:30",
      timezone: "Europe/Bratislava",
    };

    expect(() => parseAvailabilityMutation(input)).toThrow(expect.objectContaining({
      issues: [{ field: "startUtcOffset", message: "Choose the UTC offset for this ambiguous local time." }],
    }));
    expect(parseAvailabilityMutation({ ...input, startUtcOffset: "+02:00" }).startAt)
      .toEqual(new Date("2026-10-25T00:30:00.000Z"));
    expect(parseAvailabilityMutation({ ...input, startUtcOffset: "+01:00" }).startAt)
      .toEqual(new Date("2026-10-25T01:30:00.000Z"));
    expect(() => parseAvailabilityMutation({ ...input, startUtcOffset: "+03:00" })).toThrow(
      expect.objectContaining({
        issues: [{ field: "startUtcOffset", message: "The UTC offset does not match this local time." }],
      }),
    );
  });

  it("reports empty actors, invalid calendar values, offsets, and non-increasing intervals", () => {
    expect(() => parseAvailabilityMutation({
      externalActorId: " ",
      startLocal: "2026-02-30T09:00",
      endLocal: "2026-02-30T09:00",
      startUtcOffset: "CET",
      timezone: "Europe/Bratislava",
    })).toThrow(AvailabilityInputError);

    expect(() => parseAvailabilityMutation({
      externalActorId: "@user-d82a5f",
      startLocal: "2026-03-28T09:00",
      endLocal: "2026-03-28T09:00",
      timezone: "Europe/Bratislava",
    })).toThrow(expect.objectContaining({
      issues: [{ field: "endLocal", message: "End must be strictly after start." }],
    }));
  });

  it("accepts only a strict IANA timezone body", () => {
    expect(parseTimezoneInput({ timezone: "UTC" })).toBe("UTC");
    expect(() => parseTimezoneInput({ timezone: "+01:00" })).toThrow(
      expect.objectContaining({ issues: [{ field: "timezone", message: "Enter a valid IANA timezone." }] }),
    );
    expect(() => parseTimezoneInput({ timezone: "UTC", extra: true })).toThrow(
      expect.objectContaining({ issues: [{ field: "extra", message: "Unexpected field." }] }),
    );
  });
});
