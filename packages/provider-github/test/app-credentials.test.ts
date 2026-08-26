import { describe, expect, it } from "vitest";

import { validateGitHubAppCredentialsShape } from "../src/index";

describe("validateGitHubAppCredentialsShape", () => {
  it("rejects missing app id", () => {
    expect(() =>
      validateGitHubAppCredentialsShape({
        appId: "",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        webhookSecret: "secret",
      }),
    ).toThrow("GitHub App ID is required");
  });

  it("rejects a private key without PEM markers", () => {
    expect(() =>
      validateGitHubAppCredentialsShape({
        appId: "123",
        privateKey: "not-a-pem",
        webhookSecret: "secret",
      }),
    ).toThrow("GitHub private key must be PEM formatted");
  });

  it("accepts a valid shape", () => {
    expect(
      validateGitHubAppCredentialsShape({
        appId: "123",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        webhookSecret: "secret",
      }),
    ).toEqual({ appId: "123" });
  });
});
