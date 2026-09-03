import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
export interface Discovery {
  url: string;
  pid: number;
  token: string;
  version: number;
}
export function runtimeDir() {
  return process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, 'browser-controller')
    : path.join(os.tmpdir(), `browser-controller-${process.getuid?.() ?? 'user'}`);
}
export function discoveryPath() {
  return path.join(runtimeDir(), 'connection.json');
}
export function adapterCredentialsPath() {
  return path.join(runtimeDir(), 'adapter-credentials.json');
}
export async function writeDiscovery(d: Discovery) {
  const dir = runtimeDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const tmp = `${discoveryPath()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(d), 'utf8');
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, discoveryPath());
}
export async function readDiscovery() {
  try {
    const value = JSON.parse(await fs.readFile(discoveryPath(), 'utf8')) as Partial<Discovery>;
    const url = new URL(value.url ?? '');
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      !Number.isInteger(value.pid) ||
      typeof value.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.token) ||
      value.version !== 1
    )
      return undefined;
    return value as Discovery;
  } catch {
    return undefined;
  }
}
export async function removeDiscovery(expectedPid?: number) {
  try {
    if (expectedPid !== undefined) {
      const current = await readDiscovery();
      if (current?.pid !== expectedPid) return;
    }
    await fs.unlink(discoveryPath());
  } catch {}
}
export function token() {
  return crypto.randomBytes(32).toString('hex');
}
export function hashToken(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
export async function readAdapterCredentials() {
  try {
    const parsed = JSON.parse(await fs.readFile(adapterCredentialsPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([adapterId, hash]) => adapterId.length > 0 && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
      ),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}
export async function writeAdapterCredentials(credentials: Record<string, string>) {
  const dir = runtimeDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const tmp = `${adapterCredentialsPath()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, adapterCredentialsPath());
}
