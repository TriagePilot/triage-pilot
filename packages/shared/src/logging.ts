export interface LogRecord {
  level: "info" | "warn" | "error";
  event: string;
  service: "web" | "worker";
  message?: string;
  jobId?: string;
  deliveryId?: string;
  workspaceId?: string;
  provider?: string;
  providerConnectionId?: string;
  repositoryId?: string;
  changeRequestId?: string;
  providerAccountType?: string;
  providerAccountLogin?: string;
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
  if (record.workspaceId !== undefined) safeRecord.workspaceId = record.workspaceId;
  if (record.provider !== undefined) safeRecord.provider = record.provider;
  if (record.providerConnectionId !== undefined) safeRecord.providerConnectionId = record.providerConnectionId;
  if (record.repositoryId !== undefined) safeRecord.repositoryId = record.repositoryId;
  if (record.changeRequestId !== undefined) safeRecord.changeRequestId = record.changeRequestId;
  if (record.providerAccountType !== undefined) safeRecord.providerAccountType = record.providerAccountType;
  if (record.providerAccountLogin !== undefined) safeRecord.providerAccountLogin = record.providerAccountLogin;
  return JSON.stringify(safeRecord);
}
