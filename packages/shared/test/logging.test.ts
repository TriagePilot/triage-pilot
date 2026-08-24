import { describe, expect, it } from "vitest";

import { formatLog, type LogRecord } from "../src/logging";

describe("formatLog", () => {
  it("emits one newline-free JSON record with escaped message newlines", () => {
    const formatted = formatLog(
      {
        level: "error",
        event: "worker_cycle_failed",
        service: "worker",
        jobId: "job-1",
        deliveryId: "delivery-1",
        message: "first line\nsecond line",
      },
      new Date("2026-08-18T10:00:00.000Z"),
    );

    expect(formatted).not.toContain("first line\nsecond line");
    expect(formatted).toContain("first line\\nsecond line");
    expect(JSON.parse(formatted)).toEqual({
      timestamp: "2026-08-18T10:00:00.000Z",
      level: "error",
      event: "worker_cycle_failed",
      service: "worker",
      message: "first line\nsecond line",
      jobId: "job-1",
      deliveryId: "delivery-1",
    });
  });

  it("serializes only the closed safe field set", () => {
    const unsafeRuntimeRecord = {
      level: "info",
      event: "job_started",
      service: "worker",
      message: "started",
      credentials: "secret-token",
      payload: { private: true },
    } as LogRecord;

    const formatted = formatLog(unsafeRuntimeRecord, new Date("2026-08-18T10:00:00.000Z"));

    expect(formatted).not.toContain("secret-token");
    expect(formatted).not.toContain("payload");
    expect(Object.keys(JSON.parse(formatted))).toEqual(["timestamp", "level", "event", "service", "message"]);
  });

  it("rejects credentials and payloads at the TypeScript boundary", () => {
    // @ts-expect-error credentials are not part of the closed log interface
    const credentials: LogRecord = { level: "info", event: "unsafe", service: "worker", credentials: "secret" };
    // @ts-expect-error payloads are not part of the closed log interface
    const payload: LogRecord = { level: "info", event: "unsafe", service: "worker", payload: {} };

    expect(credentials.event).toBe("unsafe");
    expect(payload.event).toBe("unsafe");
  });
});
