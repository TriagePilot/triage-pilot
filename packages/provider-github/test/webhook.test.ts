import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyGitHubSignature } from "../src/webhook";

describe("verifyGitHubSignature", () => {
  it("accepts a valid sha256 signature", async () => {
    const body = JSON.stringify({ action: "opened" });
    const secret = "secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    await expect(verifyGitHubSignature({ body, secret, signature })).resolves.toBeUndefined();
  });

  it("rejects an invalid signature", async () => {
    await expect(
      verifyGitHubSignature({ body: "{}", secret: "secret", signature: "sha256=bad" }),
    ).rejects.toThrow("Invalid GitHub webhook signature");
  });
});
