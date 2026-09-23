#!/usr/bin/env node

import { chmod, lstat } from "node:fs/promises";

const paths = process.argv.slice(2);

if (paths.length === 0) {
  throw new Error("at least one runtime secret file is required");
}

for (const path of paths) {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error(`runtime secret is not a regular file: ${path}`);
  await chmod(path, 0o444);
}
