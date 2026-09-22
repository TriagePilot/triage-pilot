import { pathToFileURL } from "node:url";

import { formatLog } from "@triagepilot/shared";

import { createSelfHostedWorkerComposition } from "./composition/self-hosted.js";
import { readWorkerEnv } from "./env.js";

export async function runWorkerProcess(source: NodeJS.ProcessEnv = process.env): Promise<void> {
  const env = await readWorkerEnv(source);
  const composition = await createSelfHostedWorkerComposition(env);

  try {
    let maintenanceState = await composition.runStartup(new Date());
    console.log(formatLog({
      level: "info",
      event: "worker_started",
      service: "worker",
      workspaceId: composition.workspaceId,
      provider: "github",
    }));

    for (;;) {
      const now = new Date();
      try {
        maintenanceState = await composition.runMaintenance(maintenanceState, now);
        await composition.runOnce(now);
        await composition.drainPlatformOutbox(new Date());
      } catch (error) {
        console.error(
          formatLog({
            level: "error",
            event: "worker_cycle_failed",
            service: "worker",
            workspaceId: composition.workspaceId,
            provider: "github",
            message: error instanceof Error ? error.message : "worker cycle failed",
          }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, env.pollMs));
    }
  } finally {
    await composition.close();
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
