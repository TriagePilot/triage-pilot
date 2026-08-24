import { readFile } from "node:fs/promises";

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
}

export interface GitHubAppCredentialShape extends GitHubAppCredentials {
  webhookSecret: string;
}

async function readSecret(source: NodeJS.ProcessEnv, directName: string, fileName: string): Promise<string> {
  const direct = source[directName]?.trim();
  const file = source[fileName]?.trim();

  if (direct && file) {
    throw new Error(`${directName} and ${fileName} cannot both be set`);
  }

  const value = file ? (await readFile(file, "utf8")).trim() : direct;
  if (!value) {
    throw new Error(`${directName} or ${fileName} is required`);
  }

  return value;
}

export function validateGitHubAppCredentials(input: GitHubAppCredentials): { appId: string } {
  if (!input.appId.trim()) {
    throw new Error("GitHub App ID is required");
  }
  if (!input.privateKey.includes("-----BEGIN") || !input.privateKey.includes("PRIVATE KEY-----")) {
    throw new Error("GitHub private key must be PEM formatted");
  }

  return { appId: input.appId.trim() };
}

export function validateGitHubAppCredentialsShape(input: GitHubAppCredentialShape): { appId: string } {
  const validated = validateGitHubAppCredentials(input);
  if (!input.webhookSecret.trim()) {
    throw new Error("GitHub webhook secret is required");
  }

  return validated;
}

export async function loadGitHubAppCredentials(source: NodeJS.ProcessEnv): Promise<GitHubAppCredentials> {
  const credentials = {
    appId: source.GITHUB_APP_ID?.trim() ?? "",
    privateKey: (await readSecret(source, "GITHUB_PRIVATE_KEY", "GITHUB_PRIVATE_KEY_FILE")).replace(/\\n/g, "\n"),
  };

  validateGitHubAppCredentials(credentials);
  return credentials;
}

export async function loadGitHubCredentials(source: NodeJS.ProcessEnv): Promise<GitHubAppCredentialShape> {
  const credentials = {
    ...(await loadGitHubAppCredentials(source)),
    webhookSecret: await readSecret(source, "GITHUB_WEBHOOK_SECRET", "GITHUB_WEBHOOK_SECRET_FILE"),
  };

  validateGitHubAppCredentialsShape(credentials);
  return credentials;
}
