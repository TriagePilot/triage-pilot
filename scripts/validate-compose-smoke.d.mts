export interface ComposeSmokeSources {
  privateKey: string;
  webhookSecret: string;
  adminPassword: string;
  sessionSecret: string;
}

export function validateComposeSmokeConfig(config: unknown, sources: ComposeSmokeSources): void;
export function healthUrlFromComposePort(output: string): string;
