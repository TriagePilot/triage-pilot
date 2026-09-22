#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const expectedCommand = ["node", "apps/web/dist/server.js"];

const runtimeContract = String.raw`
if [ "$(id -u)" -eq 0 ]; then
  echo "runtime process is root" >&2
  exit 1
fi

for required in \
  /app/LICENSE \
  /app/apps/web/dist/server.js \
  /app/apps/web/dist/public/index.html \
  /app/apps/worker/dist/main.js \
  /app/packages/db/dist/migrate.js \
  /app/packages/db/migrations
do
  if [ ! -e "$required" ]; then
    echo "missing runtime artifact: $required" >&2
    exit 1
  fi
done

for forbidden in \
  /app/.github \
  /app/docs \
  /app/scripts \
  /app/test \
  /app/Dockerfile \
  /app/docker-compose.yml \
  /app/package.json \
  /app/pnpm-lock.yaml \
  /app/pnpm-workspace.yaml
do
  if [ -e "$forbidden" ]; then
    echo "forbidden runtime content: $forbidden" >&2
    exit 1
  fi
done

if find /app/apps /app/packages \
  -path '*/node_modules' -prune -o \
  -type f \( -name '*.ts' -o -name '*.tsx' \) -print -quit | grep -q .
then
  echo "TypeScript source or declarations found in runtime image" >&2
  exit 1
fi

for tool in pnpm tsx tsc vite vitest; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "development tool available at runtime: $tool" >&2
    exit 1
  fi
done

if find /app/node_modules/.pnpm -maxdepth 1 -type d \
  \( -name 'tsx@*' -o -name 'typescript@*' -o -name 'vite@*' -o -name 'vitest@*' \) \
  -print -quit | grep -q .
then
  echo "development dependency found in runtime image" >&2
  exit 1
fi

node --check /app/apps/web/dist/server.js
node --check /app/apps/worker/dist/main.js
node --check /app/packages/db/dist/migrate.js

printf 'FILE_COUNT=%s\n' "$(find /app -type f | wc -l | tr -d ' ')"
`;

export async function verifyProductionImage({ image, runDocker = executeDocker }) {
  if (typeof image !== "string" || image.length === 0) throw new Error("image reference is required");

  const configOutput = await runDocker(["image", "inspect", "--format", "{{json .Config}}", image]);
  const config = parseObject(configOutput, "image configuration");
  if (config.User !== "node") throw new Error("runtime image must configure USER node");
  if (config.WorkingDir !== "/app") throw new Error("runtime image must configure WORKDIR /app");
  if (JSON.stringify(config.Cmd) !== JSON.stringify(expectedCommand)) {
    throw new Error(`unexpected runtime command: ${JSON.stringify(config.Cmd)}`);
  }

  const contractOutput = await runDocker([
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    image,
    "-ceu",
    runtimeContract,
  ]);
  const fileCountMatch = /^FILE_COUNT=([1-9][0-9]*)$/m.exec(contractOutput);
  if (!fileCountMatch) throw new Error("runtime inspection did not report a valid file count");

  const sizeOutput = await runDocker(["image", "inspect", "--format", "{{.Size}}", image]);
  if (!/^[1-9][0-9]*\s*$/.test(sizeOutput)) throw new Error("image inspection did not report a valid size");

  return {
    fileCount: Number(fileCountMatch[1]),
    sizeBytes: Number(sizeOutput.trim()),
  };
}

async function executeDocker(args) {
  const { stdout } = await execFileAsync("docker", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

function parseObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid ${label}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid ${label}`);
  return parsed;
}

async function main() {
  const image = process.argv[2];
  const result = await verifyProductionImage({ image });
  const sizeMiB = (result.sizeBytes / 1024 / 1024).toFixed(1);
  console.log(`Production image verified: ${image}`);
  console.log(`Image size: ${result.sizeBytes} bytes (${sizeMiB} MiB)`);
  console.log(`Files under /app: ${result.fileCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
