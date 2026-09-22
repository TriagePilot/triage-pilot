import { describe, expect, it } from "vitest";

import { verifyProductionImage } from "../scripts/verify-production-image.mjs";

describe("verifyProductionImage", () => {
  it("accepts a non-root compiled runtime and reports its inventory", async () => {
    const calls: string[][] = [];
    const outputs = [
      JSON.stringify({ User: "node", Cmd: ["node", "apps/web/dist/server.js"], WorkingDir: "/app" }),
      "FILE_COUNT=321\n",
      "123456789\n",
    ];

    const result = await verifyProductionImage({
      image: "triagepilot:test",
      runDocker: async (args) => {
        calls.push(args);
        return outputs.shift() ?? "";
      },
    });

    expect(result).toEqual({ fileCount: 321, sizeBytes: 123456789 });
    expect(calls[0]).toEqual([
      "image",
      "inspect",
      "--format",
      "{{json .Config}}",
      "triagepilot:test",
    ]);
    expect(calls[1]?.slice(0, 6)).toEqual([
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      "triagepilot:test",
      "-ceu",
    ]);
  });

  it("rejects a root runtime before creating a container", async () => {
    const calls: string[][] = [];

    await expect(verifyProductionImage({
      image: "triagepilot:test",
      runDocker: async (args) => {
        calls.push(args);
        return JSON.stringify({ User: "", Cmd: ["node", "apps/web/dist/server.js"], WorkingDir: "/app" });
      },
    })).rejects.toThrow("runtime image must configure USER node");
    expect(calls).toHaveLength(1);
  });

  it("rejects an image whose default command does not run compiled JavaScript", async () => {
    await expect(verifyProductionImage({
      image: "triagepilot:test",
      runDocker: async () => JSON.stringify({
        User: "node",
        Cmd: ["pnpm", "--filter", "@triagepilot/web", "start"],
        WorkingDir: "/app",
      }),
    })).rejects.toThrow("unexpected runtime command");
  });
});
