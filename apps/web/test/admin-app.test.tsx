import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { App, Dashboard, LoginScreen } from "../src/admin/App";
import type { OperationsOverview } from "../src/admin/api";

describe("admin application", () => {
  it("starts with a useful session loading state", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Checking administrator session");
    expect(html).toContain('role="status"');
  });

  it("renders an accessible administrator login and a specific failure", () => {
    const html = renderToStaticMarkup(
      <LoginScreen
        error="Sign in failed. Check the administrator credentials."
        submitting={false}
        onSubmit={async () => {}}
      />,
    );

    expect(html).toContain('for="admin-username"');
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('for="admin-password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Sign in to TriagePilot");
    expect(html).toContain("Credentials are verified on your infrastructure");
    expect(html).toContain('src="/assets/triage-pilot-logo.png"');
    expect(html).toContain('alt="TriagePilot"');
    expect(html).not.toContain('class="routing-mark"');
    expect(html).not.toContain("GitHub private key");
    expect(html).not.toContain("Webhook secret");
    expect(html).not.toContain("Remember this device");
    expect(html).not.toContain("Forgot password");
  });

  it("wraps API-backed operations in the application navigation shell", () => {
    const html = renderToStaticMarkup(
      <Dashboard username="admin" overview={overview} onLogout={async () => {}} />,
    );

    expect(html).toContain('class="app-sidebar"');
    expect(html).toContain('aria-label="Operations navigation"');
    expect(html).toContain('href="#overview"');
    expect(html).toContain('href="#repositories"');
    expect(html).toContain('href="#decisions"');
    expect(html).toContain('href="#reviewer-availability"');
    expect(html).toContain('href="#system-health"');
    expect(html).toContain('id="repositories"');
    expect(html).toContain('id="decisions"');
    expect(html).toContain('src="/assets/triage-pilot-logo.png"');
    expect(html).toContain('role="img" aria-label="TriagePilot"');
    expect(html).toContain("Signed in as admin");
    expect(html).not.toContain("Global search");
    expect(html).not.toContain("Notifications");
    expect(html).not.toContain("PRs analyzed");
    expect(html).not.toContain("Reviewer capacity");
  });

  it("keeps heartbeat copy in English when the browser default locale is Slovak", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    const formatter = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      function DateTimeFormat(locales, options) {
        return new RealDateTimeFormat(locales ?? "sk", options);
      },
    );
    try {
      const html = renderToStaticMarkup(
        <Dashboard
          username="admin"
          overview={{
            ...overview,
            worker: {
              ...overview.worker,
              lastHeartbeatAt: "2026-08-18T12:00:00.000Z",
            },
          }}
          onLogout={async () => {}}
        />,
      );

      expect(html).toContain("Heartbeat Aug 18, 2026");
    } finally {
      formatter.mockRestore();
    }
  });

  it("renders the operational chain, recovery controls, and semantic data tables", () => {
    const html = renderToStaticMarkup(
      <Dashboard username="admin" overview={overview} onLogout={async () => {}} />,
    );

    expect(html).toContain("Operations ledger");
    expect(html).toContain("acme");
    expect(html).toContain("App 123");
    expect(html).toContain("Installation 9007199254740993");
    expect(html).toContain("Worker available");
    expect(html).toContain("Connected repositories");
    expect(html).toContain("Recent routing decisions");
    expect(html).toContain("Permanent job failures");
    expect(html).toContain("Action failures");
    expect(html).toContain("acme/api");
    expect(html).toContain("#7");
    expect(html).toContain("Human review");
    expect(html).toContain("Waiting for approval");
    expect(html).toContain('href="https://github.com/acme/api/pull/7"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("Reviewers");
    expect(html).toContain("@team-a7f19c/reviewers, @user-b4e82d");
    expect(html).toContain("GitHub permission denied");
    expect(html).toContain("Review request rejected");
    expect(html.match(/<table/g)).toHaveLength(4);
    expect(html.match(/role="region"/g)).toHaveLength(4);
    expect(html.match(/tabindex="0"/g)).toHaveLength(4);
    expect(html).toContain('aria-labelledby="repositories-heading"');
    expect(html).toContain('aria-labelledby="decisions-heading"');
    expect(html).toContain('aria-labelledby="job-failures-heading"');
    expect(html).toContain('aria-labelledby="action-failures-heading"');
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain("Run missing change request");
    expect(html).toContain("Re-run routing");
    expect(html).toContain('id="routing-recovery-url"');
    expect(html).not.toContain("<select");
  });

  it("explains empty operational sections without suggesting dashboard mutations", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        username="admin"
        overview={{
          ...overview,
          repositories: [],
          decisions: [],
          failures: { jobs: [], actions: [] },
        }}
        onLogout={async () => {}}
      />,
    );

    expect(html).toContain("No repositories are connected to this provider connection.");
    expect(html).toContain("No routing decisions have been recorded yet.");
    expect(html).toContain("No permanent job failures.");
    expect(html).toContain("No action failures.");
  });

  it("keeps an operational error visible without replacing readable data", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        username="admin"
        overview={overview}
        error="Could not sign out."
        onLogout={async () => {}}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not sign out.");
    expect(html).toContain("Connected repositories");
  });

  it("renders an explicit em dash for an unavailable legacy pull number", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        username="admin"
        overview={{
          ...overview,
          decisions: [{ ...overview.decisions[0]!, changeRequest: null }],
        }}
        onLogout={async () => {}}
      />,
    );

    expect(html).toContain('<span class="cell-detail">—</span>');
    expect(html).not.toContain("#null");
  });

  it.each([
    ["success", "Approved"],
    ["failure", "Failed"],
  ] as const)("renders %s human-review state as %s", (policyCheckState, label) => {
    const html = renderToStaticMarkup(
      <Dashboard
        username="admin"
        overview={{
          ...overview,
          decisions: [{ ...overview.decisions[0]!, policyCheckState }],
        }}
        onLogout={async () => {}}
      />,
    );

    expect(html).toContain(label);
  });

  it("explains the rules that contributed to a routing decision's risk score", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        username="admin"
        overview={
          {
            ...overview,
            decisions: [
              {
                ...overview.decisions[0],
                riskBreakdown: {
                  classifierVersion: "risk-v1",
                  tier: "medium",
                  components: [
                    {
                      reason: "changed_file_count",
                      score: 10,
                      detail: "7 changed files",
                    },
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
              },
            ],
          } as unknown as OperationsOverview
        }
        onLogout={async () => {}}
      />,
    );

    expect(html).toContain("Score breakdown");
    expect(html).toContain("risk-v1 · medium");
    expect(html).toContain("+10");
    expect(html).toContain("7 changed files");
    expect(html).toContain("+20");
    expect(html).toContain("3 files matched infrastructure/**");
    expect(html).toContain("Risk score capped at 30");
  });
});

const overview: OperationsOverview = {
  statuses: [
    { id: "workspace", label: "Organization", value: "acme" },
    {
      id: "connection",
      label: "GitHub App",
      value: "App 123",
      detail: "Installation 9007199254740993",
    },
  ],
  repositories: [
    {
      id: "repo-1",
      repository: { label: "acme/api", href: "https://github.com/acme/api" },
      configState: "valid",
      mode: "shadow",
    },
  ],
  decisions: [
    {
      id: "decision-1",
      repository: { label: "acme/api", href: "https://github.com/acme/api" },
      changeRequest: { label: "#7", href: "https://github.com/acme/api/pull/7" },
      mode: "shadow",
      action: "request_human_review",
      actionStatus: "not_applied",
      actionError: null,
      policyCheckState: "in_progress",
      riskScore: 55,
      riskBreakdown: null,
      requestedReviewerCount: 2,
      reviewerShortfall: 0,
      selectedReviewer: "@team-a7f19c/reviewers",
      selectedReviewers: ["@team-a7f19c/reviewers", "@user-b4e82d"],
      createdAt: "2026-08-18T10:00:00.000Z",
    },
  ],
  failures: {
    jobs: [
      { id: "job-1", error: "GitHub permission denied", failedAt: "2026-08-18T10:01:00.000Z" },
    ],
    actions: [
      {
        decisionId: "decision-2",
        repository: { label: "acme/api", href: "https://github.com/acme/api" },
        error: "Review request rejected",
        failedAt: "2026-08-18T10:02:00.000Z",
      },
    ],
  },
  worker: { available: true, workerId: "worker-1", lastHeartbeatAt: "2026-08-18T10:02:00.000Z" },
};
