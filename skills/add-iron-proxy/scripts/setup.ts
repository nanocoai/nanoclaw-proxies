import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getInstallSlug } from '../../../../src/install-slug.js';
import { upsertEnvVar } from '../../../../setup/set-env.js';

const pins = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'versions.json'), 'utf8'),
) as Record<string, string>;
const IMAGE = pins['iron-proxy-image'];

function readProjectEnv(projectRoot: string): Record<string, string> {
  const file = path.join(projectRoot, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

export function statePaths(projectRoot = process.cwd()) {
  const env = readProjectEnv(projectRoot);
  const materialRoot =
    process.env.NANOCLAW_SESSION_MATERIAL_ROOT ||
    env.NANOCLAW_SESSION_MATERIAL_ROOT ||
    path.join(projectRoot, 'data', 'session-materials');
  const root = path.join(materialRoot, 'iron-proxy');
  const shared = path.join(root, 'shared');
  const approvalDir = path.join(root, 'approval');
  return {
    materialRoot,
    root,
    shared,
    approvalDir,
    approvalSocket: path.join(os.tmpdir(), `nanoclaw-iron-socket-${getInstallSlug(projectRoot)}`, 'approval.sock'),
    caCert: path.join(shared, 'ca.crt'),
    caKey: path.join(shared, 'ca.key'),
    secretFile: path.join(shared, 'upstream-secret'),
    allowedHosts: path.join(shared, 'allowed-hosts.json'),
    agentCaCert: path.join(projectRoot, 'container', 'skills', 'iron-proxy-gateway', 'ca.crt'),
  };
}

export function validateAllowedHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw new Error(`Invalid allowed host: ${raw}`);
  }
  return host;
}

function readAllowedHosts(projectRoot: string): string[] {
  const file = statePaths(projectRoot).allowedHosts;
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid Iron Proxy allowed-hosts file: ${file}`);
  }
  return [...new Set(value.map(validateAllowedHost))].sort();
}

function writeAllowedHosts(hosts: readonly string[], projectRoot: string): void {
  const file = statePaths(projectRoot).allowedHosts;
  fs.writeFileSync(file, `${JSON.stringify([...new Set(hosts.map(validateAllowedHost))].sort(), null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
}

function docker(args: string[], stdout = false): string {
  return (
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', stdout ? 'pipe' : 'ignore', 'pipe'],
      timeout: 180_000,
    }) ?? ''
  ).trim();
}

function ensureCA(projectRoot: string): void {
  const paths = statePaths(projectRoot);
  const hasCert = fs.existsSync(paths.caCert);
  const hasKey = fs.existsSync(paths.caKey);
  if (hasCert !== hasKey) throw new Error(`Iron Proxy CA is incomplete under ${paths.shared}`);
  if (!hasCert) {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    docker([
      'run',
      '--rm',
      ...(uid == null ? [] : ['--user', `${uid}:${gid ?? uid}`]),
      '-v',
      `${paths.shared}:/out`,
      IMAGE,
      'generate-ca',
      '-outdir',
      '/out',
      '-name',
      `NanoClaw Iron Proxy ${getInstallSlug(projectRoot)}`,
      '-expiry-hours',
      '87600',
    ]);
  }
  fs.chmodSync(paths.caCert, 0o644);
  fs.chmodSync(paths.caKey, 0o600);
  fs.mkdirSync(path.dirname(paths.agentCaCert), { recursive: true });
  fs.copyFileSync(paths.caCert, paths.agentCaCert);
  fs.chmodSync(paths.agentCaCert, 0o644);
}

export async function configureCredential(
  credential: { secret: string; authEnv: string; modelHost: string; baseUrl?: string },
  projectRoot = process.cwd(),
): Promise<void> {
  if (!['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(credential.authEnv)) {
    throw new Error(`Unsupported Iron Proxy auth env: ${credential.authEnv}`);
  }
  if (!credential.secret || /[\r\n]/.test(credential.secret)) throw new Error('Credential must be one non-empty line');
  const paths = statePaths(projectRoot);
  fs.writeFileSync(paths.secretFile, credential.secret, { mode: 0o600 });
  fs.chmodSync(paths.secretFile, 0o600);
  upsertEnvVar('NANOCLAW_IRON_PROXY_AUTH_ENV', credential.authEnv, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_MODEL_HOST', validateAllowedHost(credential.modelHost), projectRoot);
  if (credential.baseUrl) upsertEnvVar('ANTHROPIC_BASE_URL', credential.baseUrl, projectRoot);
}

export async function run(args: string[], projectRoot = process.cwd()): Promise<void> {
  if (!/^ghcr\.io\/[a-z0-9._/-]+(?::[a-z0-9._-]+)?@sha256:[0-9a-f]{64}$/.test(IMAGE)) {
    throw new Error('Iron Proxy skill does not contain an exact image digest');
  }
  const paths = statePaths(projectRoot);
  fs.mkdirSync(paths.shared, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.approvalDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.shared, 0o700);
  fs.chmodSync(paths.approvalDir, 0o700);
  const allowIndex = args.indexOf('--allow-host');
  const allowed = readAllowedHosts(projectRoot);
  if (allowIndex >= 0) {
    if (!args[allowIndex + 1]) throw new Error('--allow-host requires a hostname or *.domain');
    allowed.push(validateAllowedHost(args[allowIndex + 1]));
  }
  writeAllowedHosts(allowed, projectRoot);
  docker(['pull', IMAGE]);
  ensureCA(projectRoot);
  if (!fs.existsSync(paths.secretFile)) fs.writeFileSync(paths.secretFile, 'not-configured', { mode: 0o600 });
  fs.chmodSync(paths.secretFile, 0o600);

  upsertEnvVar('NANOCLAW_IRON_PROXY_IMAGE', IMAGE, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_CA_CERT', paths.caCert, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_CA_KEY', paths.caKey, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_SECRET_FILE', paths.secretFile, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_APPROVAL_SOCKET', paths.approvalSocket, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_ALLOWED_HOSTS', paths.allowedHosts, projectRoot);
  if (!readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_AUTH_ENV) {
    upsertEnvVar('NANOCLAW_IRON_PROXY_AUTH_ENV', 'ANTHROPIC_API_KEY', projectRoot);
  }
  if (!readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_MODEL_HOST) {
    upsertEnvVar('NANOCLAW_IRON_PROXY_MODEL_HOST', 'api.anthropic.com', projectRoot);
  }
  console.log(`Iron Proxy ${pins['iron-proxy-fork-commit']} is ready for session-scoped startup.`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void run(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
