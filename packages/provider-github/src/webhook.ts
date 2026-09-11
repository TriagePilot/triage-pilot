import { createHmac, timingSafeEqual } from "node:crypto";

export async function verifyGitHubSignature(input: {
  body: string;
  secret: string;
  signature: string | null;
}): Promise<void> {
  if (!input.signature?.startsWith("sha256=")) {
    throw new Error("Invalid GitHub webhook signature");
  }

  const expected = `sha256=${createHmac("sha256", input.secret).update(input.body).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(input.signature);

  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new Error("Invalid GitHub webhook signature");
  }
}
