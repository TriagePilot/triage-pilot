export interface LogRecord {
  level: "info" | "warn" | "error";
  event: string;
  service: "web" | "worker";
  message?: string;
  jobId?: string;
  deliveryId?: string;
}

export function formatLog(record: LogRecord, now = new Date()): string {
  const safeRecord: Record<string, string> = {
    timestamp: now.toISOString(),
    level: record.level,
    event: record.event,
    service: record.service,
  };
  if (record.message !== undefined) safeRecord.message = record.message;
  if (record.jobId !== undefined) safeRecord.jobId = record.jobId;
  if (record.deliveryId !== undefined) safeRecord.deliveryId = record.deliveryId;
  return JSON.stringify(safeRecord);
}
