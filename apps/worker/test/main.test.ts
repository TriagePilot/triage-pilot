import { describe, expect, it } from "vitest";

import { processReviewerAbsenceActivationJob } from "../src/availability-processor";
import { createWorkerRuntimeProcessors, runGuardedWorkerMain, runWorkerProcess } from "../src/main";
import { processRoutingJob } from "../src/processor";
import { processHumanReviewPolicyJob } from "../src/review-policy-processor";

describe("worker boot", () => {
  it("supplies routing, policy, and reviewer-availability processors to the worker loop", () => {
    const runtime = createWorkerRuntimeProcessors({
      db: {} as never,
      github: { appId: "123", privateKey: "test-private-key" },
    });

    expect(runtime).toEqual({
      processRoutingJob,
      buildRoutingServices: expect.any(Function),
      processHumanReviewPolicyJob,
      buildHumanReviewPolicyServices: expect.any(Function),
      processReviewerAbsenceActivationJob,
      buildReviewerAvailabilityServices: expect.any(Function),
    });
  });

  it("turns missing configuration into one closed JSON failure record", async () => {
    const records: string[] = [];

    const exitCode = await runGuardedWorkerMain(() => runWorkerProcess({}), (record) => records.push(record));

    expect(exitCode).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).not.toContain("\n");
    expect(JSON.parse(records[0] ?? "")).toEqual({
      timestamp: expect.any(String),
      level: "error",
      event: "worker_startup_failed",
      service: "worker",
      message: "worker startup failed",
    });
  });

  it("does not expose initialization error text or secrets", async () => {
    const records: string[] = [];

    const exitCode = await runGuardedWorkerMain(
      async () => {
        throw new Error("initialization failed with super-secret\nand a multiline stack");
      },
      (record) => records.push(record),
    );

    expect(exitCode).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).not.toContain("super-secret");
    expect(records[0]).not.toContain("multiline stack");
    expect(records[0]).not.toContain("\n");
  });
});
