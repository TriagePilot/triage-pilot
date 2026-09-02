// @vitest-environment happy-dom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ReviewerAvailability,
  type AuthorizationCapabilities,
  type OperationsApiClient,
  type ReviewerAbsenceOverview,
  type ReviewerReplacementOverview,
  type WorkspaceContext,
} from "../src/index";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("reusable reviewer availability", () => {
  it("renders timezone, status, and replacement history without mutation controls in read-only mode", () => {
    const html = renderToStaticMarkup(<ReviewerAvailability
      api={api()}
      workspace={workspace}
      authorization={{ ...authorization, canManageReviewerAvailability: false }}
      initialSettings={settings}
      initialAbsences={[absence]}
      initialReplacementHistory={[replacement]}
    />);

    expect(html).toContain("Europe/Bratislava");
    expect(html).toContain("@user-d82a5f");
    expect(html).toContain("Upcoming");
    expect(html).toContain("@user-c91e46");
    expect(html).toContain("replaced");
    expect(html).not.toContain("Add absence");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Cancel<");
  });

  it("loads workspace data and does not disclose it when operations viewing is unauthorized", async () => {
    const allowedApi = api();
    const allowed = await mount(<ReviewerAvailability api={allowedApi} workspace={workspace} authorization={authorization} />);
    expect(allowed.textContent).toContain("@user-d82a5f");
    expect(allowedApi.readAvailabilitySettings).toHaveBeenCalledWith(workspace);
    await unmount();

    const deniedApi = api();
    const denied = await mount(<ReviewerAvailability
      api={deniedApi}
      workspace={workspace}
      authorization={{ ...authorization, canViewOperations: false }}
    />);
    expect(denied.textContent).toContain("not authorized");
    expect(deniedApi.readAvailabilitySettings).not.toHaveBeenCalled();
  });

  it("serializes create/edit/cancel mutations and retains invalid form input", async () => {
    let rejectCreate: ((reason: Error) => void) | undefined;
    const pendingCreate = new Promise<ReviewerAbsenceOverview>((_resolve, reject) => { rejectCreate = reject; });
    const client = api({ scheduleReviewerAbsence: vi.fn(() => pendingCreate) });
    const container = await mount(<ReviewerAvailability
      api={client}
      workspace={workspace}
      authorization={authorization}
      initialSettings={settings}
      initialAbsences={[absence]}
      initialReplacementHistory={[replacement]}
    />);
    await act(async () => {
      setValue(container, "absence-actor", "@typed-user");
      setValue(container, "absence-start", "2026-09-03T08:00");
      setValue(container, "absence-end", "2026-09-03T17:00");
    });

    await act(async () => {
      formFor(container, "absence-actor")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      formFor(container, "absence-actor")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(client.scheduleReviewerAbsence).toHaveBeenCalledTimes(1);
    expect(Array.from(container.querySelectorAll("button,input")).every((node) => (node as HTMLInputElement).disabled)).toBe(true);

    await act(async () => {
      rejectCreate?.(Object.assign(new Error("End must be strictly after start."), { status: 422 }));
      await pendingCreate.catch(() => undefined);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("End must be strictly after start.");
    expect(input(container, "absence-actor")?.value).toBe("@typed-user");
    expect(input(container, "absence-start")?.value).toBe("2026-09-03T08:00");

    await act(async () => button(container, "Edit")?.click());
    expect(input(container, "absence-start")?.value).toBe("2026-09-01T08:00");
    await act(async () => {
      formFor(container, "absence-actor")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(client.reviseReviewerAbsence).toHaveBeenCalledWith(
      workspace,
      "absence-1",
      expect.objectContaining({ expectedRevision: 2, externalActorId: "@user-d82a5f" }),
    );
    await act(async () => button(container, "Cancel")?.click());
    expect(button(container, "Confirm cancel")).not.toBeNull();
    await act(async () => {
      button(container, "Confirm cancel")?.click();
      await Promise.resolve();
    });
    expect(client.cancelReviewerAbsence).toHaveBeenCalledWith(workspace, "absence-1", 2);
  });

  it("forwards session expiry and preserves the selected timezone after an API error", async () => {
    const onUnauthorized = vi.fn();
    const client = api({
      updateAvailabilityTimezone: vi.fn(async () => {
        throw Object.assign(new Error("The administrator session has expired."), { status: 401 });
      }),
    });
    const container = await mount(<ReviewerAvailability
      api={client}
      workspace={workspace}
      authorization={authorization}
      initialSettings={settings}
      initialAbsences={[]}
      initialReplacementHistory={[]}
      onUnauthorized={onUnauthorized}
    />);
    await act(async () => setValue(container, "availability-timezone", "America/New_York"));
    await act(async () => {
      formFor(container, "availability-timezone")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onUnauthorized).toHaveBeenCalledWith("The administrator session has expired.");
    expect(input(container, "availability-timezone")?.value).toBe("America/New_York");
  });

  it("clears fetched workspace data, drafts, and errors before the next workspace data arrives", async () => {
    let resolveBSettings: ((value: typeof settings) => void) | undefined;
    let resolveBAbsences: ((value: ReviewerAbsenceOverview[]) => void) | undefined;
    let resolveBHistory: ((value: ReviewerReplacementOverview[]) => void) | undefined;
    const bSettings = new Promise<typeof settings>((resolve) => { resolveBSettings = resolve; });
    const bAbsences = new Promise<ReviewerAbsenceOverview[]>((resolve) => { resolveBAbsences = resolve; });
    const bHistory = new Promise<ReviewerReplacementOverview[]>((resolve) => { resolveBHistory = resolve; });
    const client = api({
      readAvailabilitySettings: vi.fn((activeWorkspace: WorkspaceContext) => activeWorkspace.id === workspace.id ? Promise.resolve(settings) : bSettings),
      listReviewerAbsences: vi.fn((activeWorkspace: WorkspaceContext) => activeWorkspace.id === workspace.id ? Promise.resolve([absence]) : bAbsences),
      listReviewerReplacementHistory: vi.fn((activeWorkspace: WorkspaceContext) => activeWorkspace.id === workspace.id ? Promise.resolve([replacement]) : bHistory),
      scheduleReviewerAbsence: vi.fn(async () => { throw new Error("workspace A form error"); }),
    });
    const container = await mount(<ReviewerAvailability api={client} workspace={workspace} authorization={authorization} />);
    await act(async () => {
      setValue(container, "absence-actor", "@workspace-a-draft");
      setValue(container, "absence-start", "2026-09-03T08:00");
      setValue(container, "absence-end", "2026-09-03T17:00");
      formFor(container, "absence-actor")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("workspace A form error");

    const workspaceB = { id: "workspace-2", displayName: "Workspace two" };
    await act(async () => {
      flushSync(() => {
        root?.render(<ReviewerAvailability api={client} workspace={workspaceB} authorization={authorization} />);
      });
    });

    expect(container.textContent).toContain("Loading reviewer availability");
    expect(container.textContent).not.toContain("@user-d82a5f");
    expect(container.textContent).not.toContain("@user-c91e46");
    expect(container.textContent).not.toContain("workspace A form error");
    expect(input(container, "absence-actor")).toBeNull();

    await act(async () => {
      resolveBSettings?.({ timezone: "UTC", updatedAt: "2026-09-02T00:00:00.000Z" });
      resolveBAbsences?.([{ ...absence, id: "absence-b", externalActorId: "@workspace-b" }]);
      resolveBHistory?.([]);
      await Promise.all([bSettings, bAbsences, bHistory]);
    });
    expect(container.textContent).toContain("@workspace-b");
  });

  it("replaces complete initial availability when the workspace identity changes", async () => {
    const container = await mount(<ReviewerAvailability
      api={api()}
      workspace={workspace}
      authorization={authorization}
      initialSettings={settings}
      initialAbsences={[absence]}
      initialReplacementHistory={[replacement]}
    />);
    await act(async () => setValue(container, "absence-actor", "@workspace-a-draft"));

    await act(async () => root?.render(<ReviewerAvailability
      api={api()}
      workspace={{ id: "workspace-2", displayName: "Workspace two" }}
      authorization={authorization}
      initialSettings={{ timezone: "UTC", updatedAt: "2026-09-02T00:00:00.000Z" }}
      initialAbsences={[{ ...absence, id: "absence-b", externalActorId: "@workspace-b" }]}
      initialReplacementHistory={[]}
    />));

    expect(container.textContent).toContain("@workspace-b");
    expect(container.textContent).not.toContain("@user-d82a5f");
    expect(container.textContent).not.toContain("@user-c91e46");
    expect(input(container, "absence-actor")?.value).toBe("");
  });

  it("blocks timezone changes during an edit and serializes its original UTC offsets", async () => {
    const client = api();
    const container = await mount(<ReviewerAvailability
      api={client}
      workspace={workspace}
      authorization={authorization}
      initialSettings={settings}
      initialAbsences={[absence]}
      initialReplacementHistory={[]}
    />);
    await act(async () => button(container, "Edit")?.click());

    expect(input(container, "availability-timezone")?.disabled).toBe(true);
    expect(input(container, "absence-start")?.value).toBe("2026-09-01T08:00");
    expect(input(container, "absence-start-offset")?.value).toBe("+02:00");
    await act(async () => {
      formFor(container, "availability-timezone")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(client.updateAvailabilityTimezone).not.toHaveBeenCalled();

    await act(async () => {
      formFor(container, "absence-actor")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(client.reviseReviewerAbsence).toHaveBeenCalledWith(workspace, "absence-1", {
      externalActorId: "@user-d82a5f",
      startLocal: "2026-09-01T08:00",
      endLocal: "2026-09-01T17:00",
      startUtcOffset: "+02:00",
      endUtcOffset: "+02:00",
      expectedRevision: 2,
    });
  });
});

const workspace: WorkspaceContext = { id: "workspace-1", displayName: "Workspace one" };
const authorization: AuthorizationCapabilities = {
  canViewOperations: true,
  canManageConfiguration: false,
  canManageReviewerAvailability: true,
  canRunRoutingRecovery: false,
};
const settings = { timezone: "Europe/Bratislava", updatedAt: "2026-08-18T10:00:00.000Z" };
const absence: ReviewerAbsenceOverview = {
  id: "absence-1", externalActorId: "@user-d82a5f", startAt: "2026-09-01T06:00:00.000Z",
  endAt: "2026-09-01T15:00:00.000Z", status: "upcoming", revision: 2, cancelledAt: null,
  createdAt: "2026-08-18T10:00:00.000Z", updatedAt: "2026-08-18T10:00:00.000Z",
};
const replacement: ReviewerReplacementOverview = {
  id: "replacement-1", absenceId: "absence-1", absenceRevision: 2, decisionId: "decision-1",
  unavailableActorId: "@user-d82a5f", replacementActorId: "@user-c91e46", outcome: "replaced",
  reason: "reviewer absence", state: "completed", lastError: null, completedAt: "2026-09-01T06:05:00.000Z",
};

function api(overrides: Partial<OperationsApiClient> = {}): OperationsApiClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    readOperationsOverview: vi.fn(),
    readEffectiveConfiguration: vi.fn(),
    readAvailabilitySettings: vi.fn(async () => settings),
    updateAvailabilityTimezone: vi.fn(async (_workspace, timezone) => ({ ...settings, timezone })),
    listReviewerAbsences: vi.fn(async () => [absence]),
    scheduleReviewerAbsence: vi.fn(async () => absence),
    reviseReviewerAbsence: vi.fn(async () => absence),
    cancelReviewerAbsence: vi.fn(async () => ({ ...absence, status: "cancelled" as const })),
    listReviewerReplacementHistory: vi.fn(async () => [replacement]),
    queueRoutingRecovery: vi.fn(async () => ({ jobId: "job-recovery-1" })),
    ...overrides,
  } as OperationsApiClient & Record<string, ReturnType<typeof vi.fn>>;
}

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(element);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

async function unmount() {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
}

function input(container: HTMLElement, id: string): HTMLInputElement | null {
  return container.querySelector(`#${id}`);
}
function setValue(container: HTMLElement, id: string, value: string) {
  const control = input(container, id);
  if (!control) throw new Error(`missing input ${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}
function formFor(container: HTMLElement, id: string): HTMLFormElement | null {
  return input(container, id)?.closest("form") ?? null;
}
function button(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label) ?? null;
}
