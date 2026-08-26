// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvailabilityOverview } from "@triagepilot/db";

import { AvailabilityPanel } from "../src/admin/Availability";
import { cancelAbsence, createAbsence, updateAbsence } from "../src/admin/api";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("administrator availability", () => {
  it("renders the configured timezone, absence controls, statuses, and replacement history", async () => {
    const html = renderToStaticMarkup(
      <AvailabilityPanel availability={availability} onChange={() => {}} />,
    );

    expect(html).toContain('for="availability-timezone"');
    expect(html).toContain('value="Europe/Bratislava"');
    expect(html).toContain('for="absence-reviewer-handle"');
    expect(html).toContain('for="absence-start"');
    expect(html).toContain('for="absence-end"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain("Active");
    expect(html).toContain("Upcoming");
    expect(html).toContain("Ended");
    expect(html).toContain("Cancelled");
    expect(html.match(/>Edit</g)).toHaveLength(2);
    expect(html.match(/>Cancel</g)).toHaveLength(2);
    expect(html).toContain('href="https://github.com/acme/api/pull/7"');
    expect(html).toContain("@user-c91e46");
    expect(html).toContain("replaced");
    expect(html).toContain("reviewer absence");
    expect(html).toContain("No replacement was available; the required review count was unchanged.");
    expect(html).toContain('<caption class="sr-only">Reviewer absences</caption>');

    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<AvailabilityPanel availability={availability} onChange={() => {}} />);
    });
    await act(async () => {
      buttonNamed(container, "Edit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(inputNamed(container, "absence-start")?.value).toBe("2026-09-01T08:00");
    expect(inputNamed(container, "absence-end")?.value).toBe("2026-09-01T17:00");
  });

  it("sends local wall times and revisions for absence mutations", async () => {
    const fetchMock = vi.fn(async () => Response.json(availability));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      reviewerHandle: "@user-d82a5f",
      startLocal: "2026-09-01T08:00",
      endLocal: "2026-09-01T17:00",
    };

    await createAbsence(input);
    await updateAbsence("upcoming", { ...input, expectedRevision: 3 });
    await cancelAbsence("upcoming", 3);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/operations/availability/absences",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/operations/availability/absences/upcoming",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ ...input, expectedRevision: 3 }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/operations/availability/absences/upcoming/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedRevision: 3 }),
      }),
    );
  });
});

function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label) ?? null;
}

function inputNamed(container: HTMLElement, id: string): HTMLInputElement | null {
  return container.querySelector(`#${id}`);
}

const availability: AvailabilityOverview = {
  timezone: "Europe/Bratislava",
  absences: [
    {
      id: "active",
      reviewerHandle: "@user-d82a5f",
      startAt: "2026-09-01T06:00:00.000Z",
      endAt: "2026-09-01T15:00:00.000Z",
      status: "active",
      revision: 2,
      replacements: [
        {
          id: "replacement-1",
          repository: "acme/api",
          pullNumber: 7,
          unavailableReviewer: "@user-d82a5f",
          replacementReviewer: "@user-c91e46",
          outcome: "replaced",
          reason: "reviewer absence",
          completedAt: "2026-09-01T06:05:00.000Z",
        },
      ],
    },
    {
      id: "upcoming",
      reviewerHandle: "@user-b4e82d",
      startAt: "2026-09-02T06:00:00.000Z",
      endAt: "2026-09-02T15:00:00.000Z",
      status: "upcoming",
      revision: 3,
      replacements: [],
    },
    {
      id: "ended",
      reviewerHandle: "@user-c91e46",
      startAt: "2026-08-01T06:00:00.000Z",
      endAt: "2026-08-01T15:00:00.000Z",
      status: "ended",
      revision: 1,
      replacements: [
        {
          id: "replacement-2",
          repository: "acme/api",
          pullNumber: 8,
          unavailableReviewer: "@user-c91e46",
          replacementReviewer: null,
          outcome: "no_replacement_available",
          reason: "no eligible reviewer",
          completedAt: "2026-08-01T06:05:00.000Z",
        },
      ],
    },
    {
      id: "cancelled",
      reviewerHandle: "@user-b4e82d",
      startAt: "2026-10-01T06:00:00.000Z",
      endAt: "2026-10-01T15:00:00.000Z",
      status: "cancelled",
      revision: 2,
      replacements: [],
    },
  ],
};
