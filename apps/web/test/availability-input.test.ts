import { describe, expect, it } from "vitest";

import { AvailabilityInputError, parseLocalAbsenceInput, parseTimezoneInput } from "../src/availability-input";

describe("availability input", () => {
  it("normalizes a reviewer and converts Bratislava local time to UTC", () => {
    expect(
      parseLocalAbsenceInput({
        reviewerHandle: "@User-D82A5F",
        startLocal: "2026-03-28T09:00",
        endLocal: "2026-03-28T17:00",
        timezone: "Europe/Bratislava",
      }),
    ).toMatchObject({
      reviewerHandle: "@user-d82a5f",
      startAt: new Date("2026-03-28T08:00:00.000Z"),
      endAt: new Date("2026-03-28T16:00:00.000Z"),
    });
  });

  it.each([
    ["Europe/Not_A_Zone", "timezone", "Enter a valid IANA timezone."],
    ["Europe/Bratislava", "startLocal", "Enter a valid, unambiguous local date and time."],
  ] as const)("reports field-specific invalid timezone and wall-time errors", (timezone, field, message) => {
    const input = {
      reviewerHandle: "@user-d82a5f",
      startLocal: field === "startLocal" ? "2026-03-29T02:30" : "2026-03-28T09:00",
      endLocal: "2026-03-28T17:00",
      timezone,
    };

    expect(() => parseLocalAbsenceInput(input)).toThrow(AvailabilityInputError);
    expect(() => parseLocalAbsenceInput(input)).toThrow(
      expect.objectContaining({ issues: [{ field, message }] }),
    );
  });

  it("rejects ambiguous fall-back wall times", () => {
    expect(() =>
      parseLocalAbsenceInput({
        reviewerHandle: "@user-d82a5f",
        startLocal: "2026-10-25T02:30",
        endLocal: "2026-10-25T03:30",
        timezone: "Europe/Bratislava",
      }),
    ).toThrow(expect.objectContaining({ issues: [{ field: "startLocal", message: "Enter a valid, unambiguous local date and time." }] }));
  });

  it("reports invalid handles and non-increasing windows by field", () => {
    expect(() =>
      parseLocalAbsenceInput({
        reviewerHandle: "@team-a7f19c/reviewers",
        startLocal: "2026-03-28T09:00",
        endLocal: "2026-03-28T09:00",
        timezone: "Europe/Bratislava",
      }),
    ).toThrow(
      expect.objectContaining({
        issues: [
          { field: "reviewerHandle", message: "Reviewer handle must be an individual GitHub handle." },
          { field: "endLocal", message: "End must be strictly after start." },
        ],
      }),
    );
  });

  it("accepts only IANA timezone input", () => {
    expect(parseTimezoneInput({ timezone: "UTC" })).toBe("UTC");
    expect(() => parseTimezoneInput({ timezone: "UTC", extra: true })).toThrow(
      expect.objectContaining({ issues: [{ field: "extra", message: "Unexpected field." }] }),
    );
  });

  it("rejects fixed-offset timezone input", () => {
    expect(() => parseTimezoneInput({ timezone: "+01:00" })).toThrow(
      expect.objectContaining({ issues: [{ field: "timezone", message: "Enter a valid IANA timezone." }] }),
    );
  });

  it.each(["2026-02-30T09:00", "2026-03-28T25:00"])(
    "rejects regex-valid invalid local components: %s",
    (startLocal) => {
      expect(() =>
        parseLocalAbsenceInput({
          reviewerHandle: "@user-d82a5f",
          startLocal,
          endLocal: "2026-03-28T17:00",
          timezone: "Europe/Bratislava",
        }),
      ).toThrow(
        expect.objectContaining({
          issues: [{ field: "startLocal", message: "Enter a valid, unambiguous local date and time." }],
        }),
      );
    },
  );
});
