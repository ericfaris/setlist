// npm workspaces run server scripts with cwd = packages/server, but the
// repo-root .env lives three levels up. Resolve it relative to this file's
// own location (stable whether running `tsx` from src/ or `node` from
// dist/ — both sit 3 levels below the repo root) instead of process.cwd(),
// so `npm run dev` from the repo root actually picks up the key.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';

export function rootEnvPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return join(dir, '../../../.env');
}

/** No-op if the file doesn't exist — e.g. in prod, where docker-compose injects env vars directly. */
export function loadRootEnv(): void {
  loadEnv({ path: rootEnvPath() });
}

export function rootPackageJsonPath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return join(dir, '../../../package.json');
}

/** The single source of truth for the running build's version — shown in the UI so a host can tell which deploy is live (deploys wipe in-memory rooms with no other record of what changed). */
export function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(rootPackageJsonPath(), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
