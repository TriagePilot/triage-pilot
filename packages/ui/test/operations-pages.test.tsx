// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  OverviewPage,
  RepositoriesPage,
  RoutingDecisionsPage,
  SystemHealthPage,
  type DecisionOverview,
  type OperationsOverview,
  type OperationsApiClient,
} from "../src/index";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
});
const navigation = { hrefFor: (target: string, params?: {repositoryId?:string; decisionId?:string}) => { const query = new URLSearchParams(params).toString(); return `#${target === "configuration" ? "effective-configuration" : target}${query ? `?${query}` : ""}`; } };
const authorization = {
  canViewOperations: true,
  canManageConfiguration: false,
  canManageReviewerAvailability: true,
  canRunRoutingRecovery: true,
};
const data: OperationsOverview = {
  statuses: [],
  repositories: Array.from({ length: 18 }, (_, i) => ({
    id: `r${i}`,
    repository: { label: `team/repository-${i}`, href: null },
    mode: i % 2 ? "enforce" : "shadow",
    configState: i % 2 ? "invalid" : "valid",
  })),
  decisions: Array.from({ length: 14 }, (_, i) => ({
    id: `d${i}`,
    repository: { label: `team/repository-${i % 3}`, href: null },
    changeRequest: { label: `#${i}`, href: `https://provider.test/pull/${i}` },
    mode: i % 2 ? "enforce" : "shadow",
    action: "request_human_review",
    actionStatus: i % 2 ? "failed" : "not_applied",
    actionError: i % 2 ? "Permission denied" : null,
    policyCheckState: "in_progress",
    riskScore: 90,
    riskBreakdown:
      i % 2
        ? {
            classifierVersion: "risk-v1",
            tier: "low",
            components: [
              {
                reason: "changed_file_count",
                score: 10,
                detail: "Seven changed files",
              },
            ],
          }
        : null,
    requestedReviewerCount: 2,
    reviewerShortfall: 1,
    selectedReviewer: "reviewer",
    selectedReviewers: ["reviewer"],
    createdAt: "2026-11-01T12:00:00Z",
  })),
  failures: {
    jobs: Array.from({ length: 7 }, (_, i) => ({
      id: `job-${i}`,
      error: "Detailed failure " + i + "x".repeat(200),
      failedAt: "2026-11-01T12:00:00Z",
    })),
    actions: [
      {
        decisionId: "d13",
        repository: { label: "team/repository-1", href: null },
        error: "Known failure",
        failedAt: "2026-11-01T12:00:00Z",
      },
      {
        decisionId: "old",
        repository: { label: "team/old", href: null },
        error: "Old failure",
        failedAt: "2026-11-01T12:00:00Z",
      },
    ],
  },
  worker: { available: true, workerId: "worker", lastHeartbeatAt: null },
};
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(node));
}
function rows() {
  return container.querySelectorAll("tbody > tr");
}
async function click(text: string) {
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent === text)!
      .click(),
  );
}
async function change(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      field.tagName === "SELECT"
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(
      new Event(field.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
it("shows only the latest three overview decisions and real record counts", async () => {
  await mount(<OverviewPage navigation={navigation} overview={data} onRefresh={async () => {}} />);
  expect(rows()).toHaveLength(3);
  expect(container.querySelector("table caption")?.textContent).toBe("Recent routing decisions");
  expect(container.querySelector(".summary-metrics")?.textContent).toContain(
    "18",
  );
  expect(container.querySelector(".summary-metrics")?.textContent).toContain(
    "14",
  );
  expect(container.querySelector('a[href="#system-health"]')).not.toBeNull();
});
it("paginates eight repositories, resets pagination for filters, and links configuration", async () => {
  await mount(<RepositoriesPage navigation={navigation} overview={data} onRefresh={async () => {}} />);
  expect(rows()).toHaveLength(8);
  expect(container.querySelector("table caption")?.textContent).toBe("Connected repositories");
  expect(
    container.querySelector(
      'a[href="#effective-configuration?repositoryId=r0"]',
    ),
  ).not.toBeNull();
  await click("Next");
  expect(container.textContent).toContain("Page 2 of 3");
  await change("Repository mode", "enforce");
  expect(container.textContent).toContain("Page 1 of 2");
  expect(rows()).toHaveLength(8);
  await change("Configuration state", "valid");
  expect(container.textContent).toContain("No repositories match");
  await change("Configuration state", "");
  await change("Search repositories", "repository-17");
  expect(rows()).toHaveLength(1);
  expect(container.textContent).toContain("Page 1 of 1");
});
it("uses recorded risk, filters six decisions, and expands the complete inspector", async () => {
  await mount(
    <RoutingDecisionsPage navigation={navigation}
      overview={data}
      api={{} as OperationsApiClient}
      workspace={{ id: "w", displayName: "Work" }}
      authorization={authorization}
      onRefresh={async () => {}}
    />,
  );
  expect(rows()).toHaveLength(6);
  expect(container.querySelector("table caption")?.textContent).toBe("Recent routing decisions");
  expect(container.querySelector("tbody")?.textContent).toContain("Unknown");
  await click("Next");
  expect(container.textContent).toContain("Page 2 of 3");
  await change("Decision risk", "low");
  expect(container.textContent).toContain("Page 1 of 2");
  expect(container.querySelector("tbody")?.textContent).not.toContain(
    "Unknown",
  );
  await click("View details");
  expect(container.querySelector(".decision-inspector")?.textContent).toContain(
    "Seven changed files",
  );
  expect(container.querySelector(".decision-inspector")?.textContent).toContain(
    "Waiting for approval",
  );
  expect(container.querySelector(".decision-inspector")?.textContent).toContain(
    "1 of 2 required · shortfall 1",
  );
  expect(container.querySelector(".decision-inspector")?.textContent).toContain(
    "Permission denied",
  );
  await change("Decision mode", "shadow");
  expect(container.textContent).toContain("No routing decisions match");
});
it("protects recovery against duplicate submits and reports failures", async () => {
  let reject!: (e: Error) => void;
  const queue = vi.fn(
    () =>
      new Promise<{ jobId: string }>((_y, n) => {
        reject = n;
      }),
  );
  await mount(
    <RoutingDecisionsPage navigation={navigation}
      overview={data}
      api={{ queueRoutingRecovery: queue } as unknown as OperationsApiClient}
      workspace={{ id: "w", displayName: "Work" }}
      authorization={authorization}
      onRefresh={async () => {}}
    />,
  );
  await click("View details");
  const rerun = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Re-run routing",
  )!;
  await act(async () => {
    rerun.click();
    rerun.click();
  });
  expect(queue).toHaveBeenCalledTimes(1);
  expect(
    container.querySelector<HTMLButtonElement>('button[type="submit"]')
      ?.disabled,
  ).toBe(true);
  await act(async () => reject(new Error("recovery failed")));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "recovery failed",
  );
  expect(
    container.querySelector<HTMLButtonElement>('button[type="submit"]')
      ?.disabled,
  ).toBe(false);
});
it("opens a linked decision on its page and expands it", async () => {
  await mount(
    <RoutingDecisionsPage navigation={navigation}
      overview={data}
      selectedDecisionId="d13"
      api={{} as OperationsApiClient}
      workspace={{ id: "w", displayName: "Work" }}
      authorization={authorization}
      onRefresh={async () => {}}
    />,
  );
  expect(container.textContent).toContain("Page 3 of 3");
  expect(container.querySelector(".decision-inspector")?.textContent).toContain(
    "d13",
  );
});
it("separates current health from history, paginates failures, and preserves complete errors", async () => {
  await mount(<SystemHealthPage navigation={navigation} overview={data} onRefresh={async () => {}} />);
  expect(container.querySelector(".status-ledger")?.textContent).toContain(
    "Worker available",
  );
  expect(rows()).toHaveLength(5);
  expect(container.querySelector("table caption")?.textContent).toBe("Permanent job failures");
  expect(container.querySelector(".error-detail")?.textContent).toHaveLength(
    218,
  );
  await click("Next");
  expect(rows()).toHaveLength(2);
  await click("Action failures (2)");
  expect(container.querySelector("table caption")?.textContent).toBe("Action failures");
  expect(container.textContent).toContain("Page 1 of 1");
  expect(
    container.querySelector('a[href="#decisions?decisionId=d13"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain("Decision: old");
  expect(
    container.querySelector('a[href="#decisions?decisionId=old"]'),
  ).toBeNull();
});

async function mountDecision(changes: Partial<DecisionOverview> = {}) {
  await mount(
    <RoutingDecisionsPage
      navigation={navigation}
      overview={{ ...data, decisions: [{ ...data.decisions[1]!, ...changes }] }}
      api={{} as OperationsApiClient}
      workspace={{ id: "w", displayName: "Work" }}
      authorization={authorization}
      onRefresh={async () => {}}
    />,
  );
  await click("View details");
}

it.each([
  ["not_started", "Not started"],
  ["in_progress", "Waiting for approval"],
  ["success", "Approved"],
  ["failure", "Failed"],
] as const)(
  "explains %s human-review state as %s in the decision inspector",
  async (policyCheckState, label) => {
    await mountDecision({ policyCheckState });
    const heading = Array.from(
      container.querySelectorAll(".decision-inspector dt"),
    ).find(element => element.textContent === "Human review")!;
    expect(heading.nextElementSibling?.textContent).toBe(label);
  },
);

it("explains every risk contribution, including suppressor caps, in the shipped inspector", async () => {
  await mountDecision({
    riskBreakdown: {
      classifierVersion: "risk-v1",
      tier: "medium",
      components: [
        { reason: "changed_file_count", score: 10, detail: "7 changed files" },
        { reason: "author_rule:review", score: 30, detail: "PR author @alex matched author rule" },
        {
          reason: "high_risk_path:infrastructure",
          score: 20,
          detail: "3 files matched infrastructure/**",
        },
        {
          reason: "docs_or_test_suppressor",
          score: 0,
          detail: "Risk score capped at 30",
        },
      ],
    },
  });
  const inspector = container.querySelector(".decision-inspector")!;
  expect(inspector.textContent).toContain("risk-v1 · medium");
  expect(inspector.textContent).toContain("Author rule: review");
  expect(
    Array.from(inspector.querySelectorAll(".score-components li")).map(item => ({
      score: item.querySelector("strong")?.textContent,
      detail: item.querySelector("small")?.textContent,
    })),
  ).toEqual([
    { score: "+10", detail: "7 changed files" },
    { score: "+30", detail: "PR author @alex matched author rule" },
    { score: "+20", detail: "3 files matched infrastructure/**" },
    { score: "cap", detail: "Risk score capped at 30" },
  ]);
});

it("shows an em dash and withholds recovery when the pull number is unavailable", async () => {
  await mountDecision({ changeRequest: null });
  expect(container.querySelector("tbody th .cell-detail")?.textContent).toBe("—");
  expect(container.querySelector("tbody th .cell-detail a")).toBeNull();
  expect(container.textContent).not.toContain("#null");
  expect(
    Array.from(container.querySelectorAll("button"))
      .some(button => button.textContent === "Re-run routing"),
  ).toBe(false);
});

it("keeps provider links and reviewer details in the shipped decision page", async () => {
  await mountDecision({ selectedReviewers: ["@reviewer-one", "@reviewer-two"] });
  const link = container.querySelector<HTMLAnchorElement>(
    'a[href="https://provider.test/pull/1"]',
  );
  expect(link?.textContent).toBe("team/repository-1#1");
  expect(link?.target).toBe("_blank");
  expect(link?.rel).toBe("noreferrer");
  expect(container.querySelector(".decision-inspector")?.textContent).toContain(
    "@reviewer-one, @reviewer-two",
  );
});

it("explains empty records in each shipped operations page", async () => {
  const emptyOverview = {
    ...data,
    repositories: [],
    decisions: [],
    failures: { jobs: [], actions: [] },
  };
  await mount(
    <RepositoriesPage
      navigation={navigation}
      overview={emptyOverview}
      onRefresh={async () => {}}
    />,
  );
  expect(container.textContent).toContain("No repositories are connected");
  await act(async () => root.render(
    <RoutingDecisionsPage
      navigation={navigation}
      overview={emptyOverview}
      api={{} as OperationsApiClient}
      workspace={{ id: "w", displayName: "Work" }}
      authorization={authorization}
      onRefresh={async () => {}}
    />,
  ));
  expect(container.textContent).toContain("No routing decisions have been recorded yet.");
  await act(async () => root.render(
    <SystemHealthPage
      navigation={navigation}
      overview={emptyOverview}
      onRefresh={async () => {}}
    />,
  ));
  expect(container.textContent).toContain("No permanent job failures.");
  await click("Action failures (0)");
  expect(container.textContent).toContain("No action failures.");
});
