#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALIDATOR_FILE = realpathSync(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = realpathSync(resolve(dirname(VALIDATOR_FILE), ".."));

const PRIVATE_KEY_PATH = "/run/secrets/triagepilot/private-key.pem";
const WEBHOOK_SECRET_PATH = "/run/secrets/triagepilot/webhook-secret";
const ADMIN_PASSWORD_PATH = "/run/secrets/triagepilot/admin-password";
const SESSION_SECRET_PATH = "/run/secrets/triagepilot/session-secret";
const DATABASE_URL = "postgres://triagepilot:triagepilot@postgres:5432/triagepilot";
const POSTGRES_DATA_PATH = "/var/lib/postgresql/data";
const SERVICE_ISOLATION_BYPASS_FIELDS = [
  "blkio_config",
  "cap_add",
  "cgroup",
  "cgroup_parent",
  "deploy",
  "device_cgroup_rules",
  "devices",
  "develop",
  "external_links",
  "extra_hosts",
  "gpus",
  "group_add",
  "ipc",
  "isolation",
  "links",
  "network_mode",
  "pid",
  "post_start",
  "pre_stop",
  "privileged",
  "runtime",
  "security_opt",
  "storage_opt",
  "sysctls",
  "tmpfs",
  "use_api_socket",
  "userns_mode",
  "uts",
  "volumes_from",
];

export function validateComposeSmokeConfig(config, sources) {
  const root = readRecord(config);
  const services = readRecord(root.services);
  if (!hasExactKeys(services, ["postgres", "web", "worker"])) fail();
  if (Object.hasOwn(root, "secrets") || Object.hasOwn(root, "configs")) fail();
  const projectName = readProjectName(root.name);
  if (!hasExactProjectNetwork(root, projectName) || !hasExactProjectVolume(root, projectName)) fail();

  const postgres = readService(services, "postgres");
  const web = readService(services, "web");
  const worker = readService(services, "worker");
  if ([postgres, web, worker].some((service) =>
    hasServiceInjection(service) ||
    hasServiceIsolationBypass(service) ||
    !hasExactDefaultNetworkAttachment(service)
  )) fail();

  const postgresEnvironment = readRecord(postgres.environment);
  const webEnvironment = readRecord(web.environment);
  const workerEnvironment = readRecord(worker.environment);
  const expectedSources = readExpectedSources(sources);

  const checks = {
    postgresIdentity: hasExactPostgresIdentity(postgres),
    webIdentity: hasExactApplicationIdentity(
      web,
      REPOSITORY_ROOT,
      ["pnpm", "--filter", "@triagepilot/web", "start"],
    ),
    workerIdentity: hasExactApplicationIdentity(
      worker,
      REPOSITORY_ROOT,
      ["pnpm", "--filter", "@triagepilot/worker", "start"],
    ),
    postgresHealthcheck: hasExactHealthcheck(postgres, ["CMD-SHELL", "pg_isready -U triagepilot -d triagepilot"]),
    webHealthcheck: hasExactHealthcheck(web, [
      "CMD",
      "node",
      "-e",
      "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ]),
    workerHasNoHealthcheck: !Object.hasOwn(worker, "healthcheck"),
    postgresEnvironment: hasExactEnvironment(postgresEnvironment, {
      POSTGRES_DB: "triagepilot",
      POSTGRES_PASSWORD: "triagepilot",
      POSTGRES_USER: "triagepilot",
    }),
    webEnvironment: hasExactEnvironment(webEnvironment, {
      ADMIN_PASSWORD: "",
      ADMIN_PASSWORD_FILE: ADMIN_PASSWORD_PATH,
      ADMIN_USERNAME: "smoke-admin",
      APP_BASE_URL: "http://127.0.0.1:8787",
      DATABASE_URL,
      GITHUB_APP_ID: "12345",
      GITHUB_ORGANIZATION: "smoke-organization",
      GITHUB_PRIVATE_KEY: "",
      GITHUB_PRIVATE_KEY_FILE: PRIVATE_KEY_PATH,
      GITHUB_WEBHOOK_SECRET: "",
      GITHUB_WEBHOOK_SECRET_FILE: WEBHOOK_SECRET_PATH,
      NODE_ENV: "production",
      SESSION_SECRET: "",
      SESSION_SECRET_FILE: SESSION_SECRET_PATH,
    }),
    workerEnvironment: hasExactEnvironment(workerEnvironment, {
      DATABASE_URL,
      GITHUB_APP_ID: "12345",
      GITHUB_ORGANIZATION: "smoke-organization",
      GITHUB_PRIVATE_KEY: "",
      GITHUB_PRIVATE_KEY_FILE: PRIVATE_KEY_PATH,
      NODE_ENV: "production",
      WORKER_ID: "smoke-worker",
      WORKER_POLL_MS: "250",
    }),
    postgresVolume: hasExactPostgresVolume(postgres),
    webReadOnlyBinds: hasExactReadOnlyBinds(web, [
      [expectedSources.privateKey, PRIVATE_KEY_PATH],
      [expectedSources.webhookSecret, WEBHOOK_SECRET_PATH],
      [expectedSources.adminPassword, ADMIN_PASSWORD_PATH],
      [expectedSources.sessionSecret, SESSION_SECRET_PATH],
    ]),
    workerReadOnlyBind: hasExactReadOnlyBinds(worker, [[expectedSources.privateKey, PRIVATE_KEY_PATH]]),
    webDynamicLoopbackPort: hasExactDynamicLoopbackPort(web),
    postgresHasNoPorts: portsFor(postgres).length === 0,
    workerHasNoPorts: portsFor(worker).length === 0,
  };

  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failedChecks.length > 0) fail(failedChecks);
}

export function healthUrlFromComposePort(output) {
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(output.trim());
  if (!match) throw new Error("invalid Compose health port");

  const port = Number(match[1]);
  if (port > 65_535) throw new Error("invalid Compose health port");
  return `http://127.0.0.1:${port}/health`;
}

function readService(services, name) {
  const service = readRecord(services[name]);
  if (Object.keys(service).length === 0) fail();
  return service;
}

function fail(failedChecks = []) {
  const detail = failedChecks.length > 0 ? `: ${failedChecks.join(", ")}` : "";
  throw new Error(`unsafe Compose smoke configuration${detail}`);
}

function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function hasExactEnvironment(environment, expected) {
  return hasExactKeys(environment, Object.keys(expected).sort()) &&
    Object.entries(expected).every(([name, value]) => environment[name] === value);
}

function hasExactPostgresIdentity(service) {
  return !Object.hasOwn(service, "build") &&
    service.image === "postgres:16" &&
    !Object.hasOwn(service, "pull_policy") &&
    Object.hasOwn(service, "entrypoint") &&
    service.entrypoint === null &&
    Object.hasOwn(service, "command") &&
    service.command === null;
}

function hasExactApplicationIdentity(service, repositoryRoot, expectedCommand) {
  const build = readRecord(service.build);
  return hasExactKeys(build, ["context", "dockerfile"]) &&
    build.context === repositoryRoot &&
    build.dockerfile === "Dockerfile" &&
    !Object.hasOwn(service, "image") &&
    !Object.hasOwn(service, "pull_policy") &&
    Object.hasOwn(service, "entrypoint") &&
    service.entrypoint === null &&
    hasExactStringArray(service.command, expectedCommand);
}

function hasExactStringArray(value, expected) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function hasExactHealthcheck(service, expectedTest) {
  const healthcheck = readRecord(service.healthcheck);
  return hasExactKeys(healthcheck, ["interval", "retries", "test", "timeout"]) &&
    hasExactStringArray(healthcheck.test, expectedTest) &&
    healthcheck.interval === "10s" &&
    healthcheck.timeout === "5s" &&
    healthcheck.retries === 5;
}

function hasServiceInjection(service) {
  return Object.hasOwn(service, "secrets") || Object.hasOwn(service, "configs");
}

function hasServiceIsolationBypass(service) {
  return SERVICE_ISOLATION_BYPASS_FIELDS.some((field) => Object.hasOwn(service, field));
}

function readProjectName(value) {
  if (typeof value !== "string" || !/^triagepilot-smoke-[0-9a-f]{16}$/.test(value)) fail();
  return value;
}

function hasExactProjectNetwork(root, projectName) {
  const networks = readRecord(root.networks);
  if (!hasExactKeys(networks, ["default"])) return false;

  const network = readRecord(networks.default);
  return network.name === `${projectName}_default` &&
    (network.external === undefined || network.external === false) &&
    (network.driver === undefined || network.driver === "bridge") &&
    !Object.hasOwn(network, "driver_opts") &&
    (network.attachable === undefined || network.attachable === false);
}

function hasExactDefaultNetworkAttachment(service) {
  const networks = readRecord(service.networks);
  if (!hasExactKeys(networks, ["default"])) return false;
  const attachment = networks.default;
  return attachment === null ||
    (typeof attachment === "object" && !Array.isArray(attachment) && Object.keys(attachment).length === 0);
}

function hasExactProjectVolume(root, projectName) {
  const volumes = readRecord(root.volumes);
  if (!hasExactKeys(volumes, ["postgres-data"])) return false;

  const volume = readRecord(volumes["postgres-data"]);
  return volume.name === `${projectName}_postgres-data` &&
    (volume.external === undefined || volume.external === false) &&
    (volume.driver === undefined || volume.driver === "local") &&
    !Object.hasOwn(volume, "driver_opts");
}

function readExpectedSources(value) {
  const sources = readRecord(value);
  const expected = {
    privateKey: sources.privateKey,
    webhookSecret: sources.webhookSecret,
    adminPassword: sources.adminPassword,
    sessionSecret: sources.sessionSecret,
  };
  if (Object.values(expected).some((source) => typeof source !== "string" || !isAbsolute(source))) {
    throw new Error("unsafe Compose smoke configuration");
  }
  return expected;
}

function volumesFor(service) {
  return Array.isArray(service.volumes) ? service.volumes.map(readRecord) : [];
}

function hasExactPostgresVolume(service) {
  const volumes = volumesFor(service);
  if (volumes.length !== 1) return false;
  const volume = volumes[0];
  return volume.type === "volume" &&
    volume.source === "postgres-data" &&
    volume.target === POSTGRES_DATA_PATH &&
    volume.read_only !== true &&
    hasOnlyKeys(volume, ["read_only", "source", "target", "type", "volume"]) &&
    isEmptyOptionalRecord(volume.volume);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isEmptyOptionalRecord(value) {
  return value === undefined ||
    (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function hasExactReadOnlyBinds(service, expected) {
  const volumes = volumesFor(service);
  return volumes.length === expected.length && expected.every(([source, target]) =>
    volumes.some((volume) =>
      volume.type === "bind" &&
      volume.source === source &&
      volume.target === target &&
      volume.read_only === true
    ),
  );
}

function portsFor(service) {
  return Array.isArray(service.ports) ? service.ports.map(readRecord) : [];
}

function hasExactDynamicLoopbackPort(service) {
  const ports = portsFor(service);
  if (ports.length !== 1) return false;
  const port = ports[0];
  return port.target === 8787 &&
    String(port.published) === "0" &&
    port.host_ip === "127.0.0.1" &&
    port.protocol === "tcp" &&
    port.mode === "ingress";
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  if (process.argv[2] === "--health-url") {
    console.log(healthUrlFromComposePort(process.argv[3] ?? ""));
    return;
  }

  if (process.argv[2] !== "--config-sources" || process.argv.length !== 7) {
    throw new Error("Compose smoke validation requires generated mount sources");
  }
  validateComposeSmokeConfig(JSON.parse(await readStandardInput()), {
    privateKey: process.argv[3],
    webhookSecret: process.argv[4],
    adminPassword: process.argv[5],
    sessionSecret: process.argv[6],
  });
}

const entrypoint = process.argv[1];
let isEntrypoint = false;
try {
  isEntrypoint = Boolean(entrypoint) && realpathSync(entrypoint) === VALIDATOR_FILE;
} catch {
  isEntrypoint = false;
}
if (isEntrypoint) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Compose smoke validation failed");
    process.exitCode = 1;
  }
}
