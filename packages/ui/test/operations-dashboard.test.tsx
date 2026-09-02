// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationsDashboard, type OperationsApiClient, type WorkspaceContext } from "@triagepilot/ui";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("OperationsDashboard", () => {
  it("renders reusable operational data for the active workspace", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(
        <OperationsDashboard
          api={api}
          workspace={workspace}
          authorization={{ canViewOperations: true, canManageConfiguration: true, canManageReviewerAvailability: true, canRunRoutingRecovery: false }}
          navigation={{ hrefFor: (target) => `/ops/${target}` }}
        />,
      );
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Operations ledger");
    expect(container.textContent).toContain("acme/api");
    expect(container.textContent).toContain("Worker available");
    expect(container.textContent).toContain("Recent routing decisions");
    expect(container.textContent).toContain("Waiting for approval");
    expect(container.textContent).toContain("Action failures");
    expect(container.textContent).toContain("Review request rejected");
    expect(container.textContent).toContain("Score breakdown");
    expect(container.textContent).toContain("Large line delta");
    expect(container.textContent).toContain("1 of 2 required · shortfall 1");
    expect(container.textContent).not.toContain("0 of 0 required");
    expect(
      Array.from(container.querySelectorAll("a")).some((link) => link.getAttribute("href") === "/ops/configuration"),
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll("a")).some(
        (link) => link.getAttribute("href") === "https://gitlab.example/acme/api/-/merge_requests/7",
      ),
    ).toBe(true);
    expect(container.innerHTML).not.toContain("github.com");
  });

  it("does not expose configuration editing when the host denies that capability", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(
        <OperationsDashboard
          api={api}
          workspace={workspace}
          authorization={{ canViewOperations: true, canManageConfiguration: false, canManageReviewerAvailability: false, canRunRoutingRecovery: false }}
          navigation={{ hrefFor: (target) => `/ops/${target}` }}
        />,
      );
      await flushAsyncWork();
    });

    expect(buttonNamed(container, /edit configuration/i)).toBeNull();
    expect(buttonNamed(container, /re-run routing/i)).toBeNull();
    expect(container.textContent).not.toContain("Run missing change request");
    expect(container.textContent).toContain("Operations ledger");
  });

  it("does not disclose supplied operations data or recovery controls without view capability", () => {
    const html = renderToStaticMarkup(<OperationsDashboard
      api={api}
      workspace={workspace}
      authorization={{ canViewOperations: false, canManageConfiguration: false, canManageReviewerAvailability: false, canRunRoutingRecovery: true }}
      navigation={{ hrefFor: (target) => `/ops/${target}` }}
      initialOverview={overview}
    />);

    expect(html).toContain("Operations are not available for this workspace.");
    expect(html).not.toContain("acme/api");
    expect(html).not.toContain("Run missing change request");
    expect(html).not.toContain("Re-run routing");
  });

  it("queues recovery for a displayed decision and refreshes the ledger after success", async () => {
    const client = apiClient();
    const refreshed = { ...overview, decisions: [{ ...overview.decisions[0]!, riskScore: 77 }] };
    client.readOperationsOverview.mockResolvedValue(refreshed);
    const container = await mountDashboard(client);

    await act(async () => {
      buttonNamed(container, /re-run routing/i)?.click();
      await flushAsyncWork();
    });
    expect(client.queueRoutingRecovery).toHaveBeenCalledWith(workspace, { decisionId: "decision-1" });
    expect(container.textContent).toContain("Routing run queued");

    await act(async () => {
      buttonNamed(container, /refresh ledger/i)?.click();
      await flushAsyncWork();
    });
    expect(client.readOperationsOverview).toHaveBeenCalledWith(workspace);
    expect(container.textContent).toContain("77");
  });

  it("queues a missing change request, retains errors, and clears the input only after success", async () => {
    const client = apiClient();
    client.queueRoutingRecovery
      .mockRejectedValueOnce(Object.assign(new Error("Enter a valid provider change-request URL."), { status: 422 }))
      .mockResolvedValueOnce({ jobId: "job-recovery-1" });
    const container = await mountDashboard(client);
    await act(async () => setValue(container, "routing-recovery-url", "https://provider.example/acme/api/changes/7"));

    await act(async () => {
      formFor(container, "routing-recovery-url")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushAsyncWork();
    });
    expect(container.textContent).toContain("Enter a valid provider change-request URL.");
    expect(input(container, "routing-recovery-url")?.value).toBe("https://provider.example/acme/api/changes/7");

    await act(async () => {
      formFor(container, "routing-recovery-url")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushAsyncWork();
    });
    expect(client.queueRoutingRecovery).toHaveBeenLastCalledWith(workspace, {
      changeRequestUrl: "https://provider.example/acme/api/changes/7",
    });
    expect(input(container, "routing-recovery-url")?.value).toBe("");
  });

  it("serializes recovery mutations across decision and missing-request controls", async () => {
    let resolveQueue: ((value: { jobId: string }) => void) | undefined;
    const pendingQueue = new Promise<{ jobId: string }>((resolve) => { resolveQueue = resolve; });
    const client = apiClient();
    client.queueRoutingRecovery.mockImplementation(() => pendingQueue);
    const container = await mountDashboard(client);
    await act(async () => setValue(container, "routing-recovery-url", "https://provider.example/acme/api/changes/7"));

    await act(async () => {
      buttonNamed(container, /re-run routing/i)?.click();
      formFor(container, "routing-recovery-url")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(client.queueRoutingRecovery).toHaveBeenCalledTimes(1);
    expect(buttonNamed(container, /queueing/i)?.disabled).toBe(true);
    expect(input(container, "routing-recovery-url")?.disabled).toBe(true);

    await act(async () => {
      resolveQueue?.({ jobId: "job-recovery-1" });
      await pendingQueue;
    });
    expect(buttonNamed(container, /re-run routing/i)?.disabled).toBe(false);
  });

  it("returns recovery session expiry to the host without rendering it as an operation error", async () => {
    const onUnauthorized = vi.fn();
    const client = apiClient();
    client.queueRoutingRecovery.mockRejectedValue(Object.assign(
      new Error("The administrator session has expired."),
      { status: 401 },
    ));
    const container = await mountDashboard(client, onUnauthorized);

    await act(async () => {
      buttonNamed(container, /re-run routing/i)?.click();
      await flushAsyncWork();
    });
    expect(onUnauthorized).toHaveBeenCalledWith("The administrator session has expired.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

const workspace: WorkspaceContext = {
  id: "ws_local",
  displayName: "Self-hosted",
};

const api: OperationsApiClient = {
  async readOperationsOverview(inputWorkspace) {
    expect(inputWorkspace).toEqual(workspace);
    return {
      statuses: [
        { id: "workspace", label: "Group", value: "acme" },
        { id: "connection", label: "GitLab application", value: "Connected", detail: "Connection 42" },
      ],
      repositories: [
        {
          id: "repo-1",
          repository: { label: "acme/api", href: "https://gitlab.example/acme/api" },
          configState: "valid",
          mode: "shadow",
        },
      ],
      decisions: [
        {
          id: "decision-1",
          repository: { label: "acme/api", href: "https://gitlab.example/acme/api" },
          changeRequest: {
            label: "!7",
            href: "https://gitlab.example/acme/api/-/merge_requests/7",
          },
          mode: "shadow",
          action: "request_human_review",
          actionStatus: "failed",
          actionError: "Review request rejected",
          policyCheckState: "in_progress",
          riskScore: 55,
          riskBreakdown: {
            classifierVersion: "risk-v2",
            tier: "medium",
            components: [
              {
                reason: "large_line_delta",
                score: 25,
                detail: "1,200 changed lines",
              },
            ],
          },
          selectedReviewer: "@team-a7f19c/reviewers",
          selectedReviewers: ["@team-a7f19c/reviewers"],
          requestedReviewerCount: 2,
          reviewerShortfall: 1,
          createdAt: "2026-08-18T10:00:00.000Z",
        },
      ],
      failures: {
        jobs: [],
        actions: [
          {
            decisionId: "decision-1",
            repository: { label: "acme/api", href: "https://gitlab.example/acme/api" },
            error: "Review request rejected",
            failedAt: "2026-08-18T10:02:00.000Z",
          },
        ],
      },
      worker: { available: true, workerId: "worker-1", lastHeartbeatAt: "2026-08-18T10:02:00.000Z" },
    };
  },
  async readEffectiveConfiguration() {
    throw new Error("not used by OperationsDashboard");
  },
  async queueRoutingRecovery() {
    return { jobId: "job-recovery-1" };
  },
};

const overview = await api.readOperationsOverview(workspace);

function apiClient() {
  return {
    ...api,
    readOperationsOverview: vi.fn(async () => overview),
    queueRoutingRecovery: vi.fn(async () => ({ jobId: "job-recovery-1" })),
  } as OperationsApiClient & {
    readOperationsOverview: ReturnType<typeof vi.fn>;
    queueRoutingRecovery: ReturnType<typeof vi.fn>;
  };
}

async function mountDashboard(client: OperationsApiClient, onUnauthorized?: (message: string) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<OperationsDashboard
      api={client}
      workspace={workspace}
      authorization={{ canViewOperations: true, canManageConfiguration: false, canManageReviewerAvailability: false, canRunRoutingRecovery: true }}
      navigation={{ hrefFor: (target) => `/ops/${target}` }}
      initialOverview={overview}
      {...(onUnauthorized ? { onUnauthorized } : {})}
    />);
  });
  return container;
}

function buttonNamed(container: HTMLElement, label: RegExp): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((button) =>
      label.test(button.textContent?.trim() ?? ""),
    ) ?? null
  );
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

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
