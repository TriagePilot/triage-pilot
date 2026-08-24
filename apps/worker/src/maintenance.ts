const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface WorkerMaintenanceServices {
  recoverStaleJobs(now: Date): Promise<void>;
  applyRetention(now: Date): Promise<void>;
  updateHeartbeat(now: Date): Promise<void>;
}

export interface WorkerMaintenanceState {
  lastRetentionAt: Date;
}

export async function runWorkerStartup(
  services: WorkerMaintenanceServices,
  now: Date,
): Promise<WorkerMaintenanceState> {
  await services.recoverStaleJobs(now);
  await services.applyRetention(now);
  await services.updateHeartbeat(now);
  return { lastRetentionAt: now };
}

export async function runWorkerMaintenance(
  state: WorkerMaintenanceState,
  services: WorkerMaintenanceServices,
  now: Date,
): Promise<WorkerMaintenanceState> {
  await services.recoverStaleJobs(now);
  await services.updateHeartbeat(now);
  if (now.getTime() - state.lastRetentionAt.getTime() < RETENTION_INTERVAL_MS) return state;

  await services.applyRetention(now);
  return { lastRetentionAt: now };
}
