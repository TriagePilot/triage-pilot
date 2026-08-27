import { pathToFileURL } from "node:url";

import {
  createJobClaimer,
  createDatabase,
  createWorkspaceRepositories,
  ensureLocalWorkspace,
  updateWorkerHeartbeat,
} from "@triagepilot/db";
import { formatLog } from "@triagepilot/shared";

import { readWorkerEnv } from "./env";
import { runWorkerMaintenance, runWorkerStartup } from "./maintenance";
import { processRoutingJob } from "./processor";
import { processHumanReviewPolicyJob } from "./review-policy-processor";
import { runWorkerOnce } from "./runner";
import {
  createWorkerHumanReviewPolicyServiceFactory,
  createWorkerRoutingServiceFactory,
} from "./runtime-services";

export async function runWorkerProcess(source: NodeJS.ProcessEnv = process.env): Promise<void> {
  const env = await readWorkerEnv(source);
  const db = createDatabase(env.databaseUrl);

  try {
    const workspaceId = await ensureLocalWorkspace(db);
    const localRepositories = createWorkspaceRepositories(db, workspaceId);
    const jobClaimer = createJobClaimer(db);
    const buildRoutingServices = createWorkerRoutingServiceFactory({ db, github: env.github });
    const buildHumanReviewPolicyServices = createWorkerHumanReviewPolicyServiceFactory({ db, github: env.github });
    const maintenanceServices = {
      async recoverStaleJobs(now: Date) {
        await localRepositories.recoverStaleJobs(now);
      },
      async applyRetention(now: Date) {
        await localRepositories.applyFixedRetention(now);
      },
      async updateHeartbeat(now: Date) {
        await updateWorkerHeartbeat(db, { workerId: env.workerId, now });
      },
    };
    let maintenanceState = await runWorkerStartup(maintenanceServices, new Date());
    console.log(formatLog({ level: "info", event: "worker_started", service: "worker" }));

    for (;;) {
      const now = new Date();
      try {
        maintenanceState = await runWorkerMaintenance(maintenanceState, maintenanceServices, now);
        await runWorkerOnce({
          jobClaimer,
          workspaceQueue: (claimedWorkspaceId) => createWorkspaceRepositories(db, claimedWorkspaceId).jobs,
          workerId: env.workerId,
          now,
          processRoutingJob,
          buildRoutingServices,
          processHumanReviewPolicyJob,
          buildHumanReviewPolicyServices,
        });
      } catch (error) {
        console.error(
          formatLog({
            level: "error",
            event: "worker_cycle_failed",
            service: "worker",
            message: error instanceof Error ? error.message : "worker cycle failed",
          }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, env.pollMs));
    }
  } finally {
    await db.destroy();
  }
}

export async function runGuardedWorkerMain(
  start: () => Promise<void> = () => runWorkerProcess(),
  writeError: (record: string) => void = (record) => console.error(record),
): Promise<number> {
  try {
    await start();
    return 0;
  } catch {
    writeError(
      formatLog({
        level: "error",
        event: "worker_startup_failed",
        service: "worker",
        message: "worker startup failed",
      }),
    );
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runGuardedWorkerMain();
}
