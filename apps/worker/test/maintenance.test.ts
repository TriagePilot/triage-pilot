import { describe, expect, it, vi } from "vitest";

import { runWorkerMaintenance, runWorkerStartup } from "../src/maintenance";

function buildServices() {
  return {
    recoverStaleJobs: vi.fn(async (_now: Date) => {}),
    applyRetention: vi.fn(async (_now: Date) => {}),
    updateHeartbeat: vi.fn(async (_now: Date) => {}),
  };
}

describe("worker maintenance", () => {
  it("always recovers stale jobs, applies fixed retention, and heartbeats at startup", async () => {
    const services = buildServices();
    const now = new Date("2026-08-18T10:00:00.000Z");

    await expect(runWorkerStartup(services, now)).resolves.toEqual({ lastRetentionAt: now });
    expect(services.recoverStaleJobs).toHaveBeenCalledOnce();
    expect(services.recoverStaleJobs).toHaveBeenCalledWith(now);
    expect(services.applyRetention).toHaveBeenCalledOnce();
    expect(services.applyRetention).toHaveBeenCalledWith(now);
    expect(services.updateHeartbeat).toHaveBeenCalledOnce();
    expect(services.updateHeartbeat).toHaveBeenCalledWith(now);
  });

  it("recovers stale jobs and heartbeats on every cycle without early retention", async () => {
    const services = buildServices();
    const lastRetentionAt = new Date("2026-08-18T10:00:00.000Z");
    const now = new Date("2026-08-19T09:00:00.000Z");

    await expect(runWorkerMaintenance({ lastRetentionAt }, services, now)).resolves.toEqual({ lastRetentionAt });
    expect(services.recoverStaleJobs).toHaveBeenCalledWith(now);
    expect(services.updateHeartbeat).toHaveBeenCalledWith(now);
    expect(services.applyRetention).not.toHaveBeenCalled();
  });

  it("heartbeats and applies retention at exactly 24 hours", async () => {
    const services = buildServices();
    const lastRetentionAt = new Date("2026-08-18T10:00:00.000Z");
    const now = new Date("2026-08-19T10:00:00.000Z");

    await expect(runWorkerMaintenance({ lastRetentionAt }, services, now)).resolves.toEqual({ lastRetentionAt: now });
    expect(services.updateHeartbeat).toHaveBeenCalledWith(now);
    expect(services.applyRetention).toHaveBeenCalledWith(now);

    const nextCycle = new Date("2026-08-19T10:00:01.000Z");
    await runWorkerMaintenance({ lastRetentionAt: now }, services, nextCycle);
    expect(services.updateHeartbeat).toHaveBeenCalledTimes(2);
    expect(services.applyRetention).toHaveBeenCalledOnce();
  });
});
