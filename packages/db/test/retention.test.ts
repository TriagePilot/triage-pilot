import { describe, expect, it } from "vitest";

import {
  applyFixedRetention,
  DECISION_AND_FAILURE_DAYS,
  RECEIPT_AND_COMPLETED_JOB_DAYS,
} from "../src/retention";

describe("applyFixedRetention", () => {
  it("uses the fixed reduced policy without targeting active jobs", async () => {
    const deletes: Array<{ table: string; conditions: unknown[][] }> = [];
    const db = {
      deleteFrom(table: string) {
        const conditions: unknown[][] = [];
        const query = {
          where(...condition: unknown[]) {
            conditions.push(condition);
            return query;
          },
          async execute() {
            deletes.push({ table, conditions });
          },
        };
        return query;
      },
    };

    await applyFixedRetention(db as never, new Date("2026-08-18T10:00:00.000Z"));

    expect(RECEIPT_AND_COMPLETED_JOB_DAYS).toBe(30);
    expect(DECISION_AND_FAILURE_DAYS).toBe(90);
    expect(deletes).toEqual([
      {
        table: "webhook_receipts",
        conditions: [["created_at", "<", new Date("2026-07-19T10:00:00.000Z")]],
      },
      {
        table: "jobs",
        conditions: [
          ["status", "=", "succeeded"],
          ["updated_at", "<", new Date("2026-07-19T10:00:00.000Z")],
        ],
      },
      {
        table: "jobs",
        conditions: [
          ["status", "=", "failed"],
          ["updated_at", "<", new Date("2026-05-20T10:00:00.000Z")],
        ],
      },
      {
        table: "routing_decisions",
        conditions: [["created_at", "<", new Date("2026-05-20T10:00:00.000Z")]],
      },
    ]);
  });
});
