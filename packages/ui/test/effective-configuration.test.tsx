// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { EffectiveConfiguration, type OperationsApiClient, type WorkspaceContext } from "@triagepilot/ui";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("EffectiveConfiguration", () => {
  it("renders each effective value with source labels and trusted provenance", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(
        <EffectiveConfiguration
          api={api}
          workspace={workspace}
          repository={repository}
          authorization={{ canViewOperations: true, canManageConfiguration: false, canManageReviewerAvailability: false, canRunRoutingRecovery: false }}
          navigation={{ hrefFor: (target) => `/ops/${target}` }}
        />,
      );
      await flushAsyncWork();
    });

    expect(container.textContent).toContain("Effective configuration");
    expect(container.textContent).toContain("Trusted path");
    expect(container.textContent).toContain(".triagepilot.yml");
    expect(container.textContent).toContain("Trusted revision");
    expect(container.textContent).toContain("trusted-base-sha");
    expect(container.textContent).toContain("mode");
    expect(container.textContent).toContain("shadow");
    expect(container.textContent).toContain("repository source");
    expect(container.textContent).toContain("routing.includeDraftPullRequests");
    expect(container.textContent).toContain("false");
    expect(container.textContent).toContain("default source");
    expect(container.textContent).toContain("ownership.requiredApprovalCount");
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("organization source");
    expect(buttonNamed(container, /edit configuration/i)).toBeNull();
  });
});

const workspace: WorkspaceContext = {
  id: "ws_local",
  displayName: "Self-hosted",
};

const repository = {
  id: "repo-1",
  repository: { label: "acme/api", href: "https://gitlab.example/acme/api" },
};

const api: OperationsApiClient = {
  async readOperationsOverview() {
    throw new Error("not used by EffectiveConfiguration");
  },
  async readEffectiveConfiguration(inputWorkspace, inputRepository) {
    expect(inputWorkspace).toEqual(workspace);
    expect(inputRepository).toEqual(repository);
    return {
      repository: repository.repository,
      trustedPath: ".triagepilot.yml",
      trustedRevision: "trusted-base-sha",
      repositoryRevision: "trusted-base-sha",
      inheritanceMode: "inherit",
      effectiveHash: "a".repeat(64),
      values: [
        { path: "$.mode", label: "mode", value: "shadow", source: "repository" },
        {
          path: "$.routing.includeDraftPullRequests",
          label: "routing.includeDraftPullRequests",
          value: false,
          source: "default",
        },
        {
          path: "$.ownership.requiredApprovalCount",
          label: "ownership.requiredApprovalCount",
          value: 2,
          source: "organization",
        },
      ],
    };
  },
  async queueRoutingRecovery() { return { jobId: "job-recovery-1" }; },
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

it("filters configuration categories, expands details, and retries a failed read", async () => {
  let reads = 0;
  const client = { ...api, async readEffectiveConfiguration(w: WorkspaceContext, r: typeof repository) {
    if (++reads === 1) throw new Error("temporary configuration outage");
    const value = await api.readEffectiveConfiguration(w, r);
    return { ...value, trustedPath: "config/review-policy.yml", values: [...value.values, {path:"$.risk.minimumScore", label:"risk.minimumScore", value:25, source:"default" as const}] };
  }};
  const container = document.createElement("div"); document.body.append(container);
  await act(async () => { root = createRoot(container);root.render(<EffectiveConfiguration api={client} workspace={workspace} repository={repository} authorization={{canViewOperations:true,canManageConfiguration:false,canManageReviewerAvailability:false,canRunRoutingRecovery:false}} navigation={{hrefFor:()=>"/configuration"}}/>); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("temporary configuration outage");
  await act(async () => Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Retry configuration')!.click());
  expect(container.textContent).toContain('config/review-policy.yml');
  await act(async () => Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Risk scoring')!.click());
  expect(container.querySelector('tbody')?.textContent).toContain('risk.minimumScore');
  expect(container.querySelector('tbody')?.textContent).not.toContain('routing.includeDraftPullRequests');
  expect(container.querySelector('details')?.open).toBe(false);
  await act(async () => Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Ownership')!.click());
  expect(container.querySelector('tbody')?.textContent).toContain('ownership.requiredApprovalCount');
});
