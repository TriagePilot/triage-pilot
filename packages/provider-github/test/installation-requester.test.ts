import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  App: vi.fn(),
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@octokit/app", () => ({ App: mocks.App }));

import { createInstallationRequester } from "../src/adapter";

describe("createInstallationRequester", () => {
  beforeEach(() => {
    mocks.App.mockReset();
    mocks.getInstallationOctokit.mockReset();
    mocks.getInstallationOctokit.mockResolvedValue({ request: vi.fn() });
    mocks.App.mockImplementation(() => ({ getInstallationOctokit: mocks.getInstallationOctokit }));
  });

  it("creates an installation-scoped requester from configured App credentials", async () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----";

    const requester = await createInstallationRequester({ appId: "123", privateKey, installationId: 99 });

    expect(mocks.App).toHaveBeenCalledWith({ appId: "123", privateKey });
    expect(mocks.getInstallationOctokit).toHaveBeenCalledWith(99);
    expect(requester).toEqual(expect.objectContaining({ request: expect.any(Function) }));
  });
});
