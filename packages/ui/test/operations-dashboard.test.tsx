// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

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
          authorization={{ canViewOperations: true, canManageConfiguration: true }}
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
    expect(
      Array.from(container.querySelectorAll("a")).some((link) => link.getAttribute("href") === "/ops/configuration"),
    ).toBe(true);
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
          authorization={{ canViewOperations: true, canManageConfiguration: false }}
          navigation={{ hrefFor: (target) => `/ops/${target}` }}
        />,
      );
      await flushAsyncWork();
    });

    expect(buttonNamed(container, /edit configuration/i)).toBeNull();
    expect(container.textContent).toContain("Operations ledger");
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
      organization: "acme",
      githubApp: { appId: "123", configured: true, installationId: "9007199254740993" },
      repositories: [
        { id: "repo-1", owner: "acme", name: "api", configState: "valid", mode: "shadow" },
      ],
      decisions: [
        {
          id: "decision-1",
          repository: "acme/api",
          pullNumber: 7,
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
          selectedReviewers: ["@team-a7f19c/reviewers", "@user-b4e82d"],
          createdAt: "2026-08-18T10:00:00.000Z",
        },
      ],
      failures: {
        jobs: [],
        actions: [
          {
            decisionId: "decision-1",
            repository: "acme/api",
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
};

function buttonNamed(container: HTMLElement, label: RegExp): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((button) =>
      label.test(button.textContent?.trim() ?? ""),
    ) ?? null
  );
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
