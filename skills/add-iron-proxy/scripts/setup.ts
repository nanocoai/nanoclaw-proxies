import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getInstallSlug } from '../../../../src/install-slug.js';
import { upsertEnvVar } from '../../../../setup/set-env.js';

const pins = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'versions.json'), 'utf8'),
) as Record<string, string>;
const IMAGE = pins['iron-proxy-image'];
const PLACEHOLDER = 'gateway-managed';
const DEFAULT_MODEL_HOST = 'api.anthropic.com';
const DIRECT_HTTP_PORT = 18081;
const DIRECT_HTTPS_PORT = 18443;

function statePaths(projectRoot = process.cwd()) {
  const stateDir = path.join(projectRoot, 'data', 'gateways', 'iron-proxy');
  return {
    stateDir,
    caCert: path.join(stateDir, 'ca.crt'),
    caKey: path.join(stateDir, 'ca.key'),
    config: path.join(stateDir, 'config.yaml'),
    secrets: path.join(stateDir, 'secrets.env'),
    allowedHosts: path.join(stateDir, 'allowed-hosts.json'),
  };
}

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

function addAllowedHost(host: string, projectRoot: string): void {
  const paths = statePaths(projectRoot);
  const hosts = [...new Set([...readAllowedHosts(projectRoot), validateAllowedHost(host)])].sort();
  fs.writeFileSync(paths.allowedHosts, `${JSON.stringify(hosts, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(paths.allowedHosts, 0o600);
}

export function renderConfig(port: number, modelHost: string, allowedHosts: readonly string[]): string {
  const domains = [...new Set([validateAllowedHost(modelHost), ...allowedHosts.map(validateAllowedHost)])].sort();
  return `dns:
  enabled: false

proxy:
  http_listen: ":${DIRECT_HTTP_PORT}"
  https_listen: ":${DIRECT_HTTPS_PORT}"
  tunnel_listen: ":${port}"
  upstream_response_header_timeout: "5m"

tls:
  ca_cert: "/etc/iron-proxy/ca.crt"
  ca_key: "/etc/iron-proxy/ca.key"

transforms:
  - name: allowlist
    config:
      domains:
${domains.map((host) => `        - ${JSON.stringify(host)}`).join('\n')}
  - name: secrets
    config:
      secrets:
        - source:
            type: env
            var: IRON_UPSTREAM_CLAUDE
          replace:
            proxy_value: ${JSON.stringify(PLACEHOLDER)}
            match_headers: ["Authorization", "x-api-key"]
            require: true
          rules:
            - host: ${JSON.stringify(validateAllowedHost(modelHost))}

metrics:
  listen: "127.0.0.1:19090"

log:
  level: "info"
`;
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function configuredPort(projectRoot: string): Promise<number> {
  const existing = Number(process.env.NANOCLAW_IRON_PROXY_PORT || readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_PORT);
  if (Number.isInteger(existing) && existing >= 1024 && existing <= 65535) return existing;
  let port = await availablePort();
  while (port === DIRECT_HTTP_PORT || port === DIRECT_HTTPS_PORT) port = await availablePort();
  return port;
}

function docker(args: string[], options: { stdout?: boolean } = {}): string {
  return (execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', options.stdout ? 'pipe' : 'ignore', 'pipe'],
    timeout: 120_000,
  }) ?? '').trim();
}

function ensureCA(projectRoot: string): void {
  const paths = statePaths(projectRoot);
  const hasCert = fs.existsSync(paths.caCert);
  const hasKey = fs.existsSync(paths.caKey);
  if (hasCert !== hasKey) throw new Error(`Iron Proxy CA is incomplete under ${paths.stateDir}`);
  if (!hasCert) {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    docker([
      'run',
      '--rm',
      ...(uid == null ? [] : ['--user', `${uid}:${gid ?? uid}`]),
      '-v',
      `${paths.stateDir}:/out`,
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
}

function ensureSecretsFile(projectRoot: string): void {
  const file = statePaths(projectRoot).secrets;
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'IRON_UPSTREAM_CLAUDE=not-configured\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writeConfig(projectRoot: string, port: number, modelHost: string): void {
  const file = statePaths(projectRoot).config;
  fs.writeFileSync(file, renderConfig(port, modelHost, readAllowedHosts(projectRoot)), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function containerName(projectRoot: string): string {
  return `nanoclaw-iron-proxy-${getInstallSlug(projectRoot)}`;
}

function removeOwnedContainer(projectRoot: string): void {
  const name = containerName(projectRoot);
  let owner = '';
  try {
    owner = docker(['inspect', '--format', '{{ index .Config.Labels "nanoclaw-install" }}', name], { stdout: true });
  } catch {
    return;
  }
  const expected = getInstallSlug(projectRoot);
  if (owner !== expected) throw new Error(`Refusing to replace container ${name}: ownership label is '${owner || '(missing)'}'`);
  docker(['rm', '--force', name]);
}

async function waitRunning(name: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if (docker(['inspect', '--format', '{{.State.Running}}', name], { stdout: true }) === 'true') return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  let logs = '';
  try {
    logs = docker(['logs', '--tail', '20', name], { stdout: true });
  } catch {
    // the actionable container name remains in the error
  }
  throw new Error(`Iron Proxy did not stay running (${name})${logs ? `: ${logs}` : ''}`);
}

export async function startProxy(projectRoot = process.cwd()): Promise<void> {
  const env = readProjectEnv(projectRoot);
  const port = Number(env.NANOCLAW_IRON_PROXY_PORT);
  if (!Number.isInteger(port)) throw new Error('Iron Proxy port is not configured');
  const paths = statePaths(projectRoot);
  const name = containerName(projectRoot);
  docker(['pull', IMAGE]);
  removeOwnedContainer(projectRoot);
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `nanoclaw-install=${getInstallSlug(projectRoot)}`,
    '--restart',
    'unless-stopped',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '-p',
    `127.0.0.1:${port}:${port}`,
    '--env-file',
    paths.secrets,
    '-v',
    `${paths.config}:/etc/iron-proxy/config.yaml:ro`,
    '-v',
    `${paths.caCert}:/etc/iron-proxy/ca.crt:ro`,
    '-v',
    `${paths.caKey}:/etc/iron-proxy/ca.key:ro`,
    IMAGE,
    '-config',
    '/etc/iron-proxy/config.yaml',
  ]);
  await waitRunning(name);
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
  fs.writeFileSync(paths.secrets, `IRON_UPSTREAM_CLAUDE=${credential.secret}\n`, { mode: 0o600 });
  fs.chmodSync(paths.secrets, 0o600);
  upsertEnvVar('NANOCLAW_IRON_PROXY_AUTH_ENV', credential.authEnv, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_MODEL_HOST', validateAllowedHost(credential.modelHost), projectRoot);
  if (credential.baseUrl) upsertEnvVar('ANTHROPIC_BASE_URL', credential.baseUrl, projectRoot);
  writeConfig(projectRoot, Number(readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_PORT), credential.modelHost);
  await startProxy(projectRoot);
}

export async function run(args: string[], projectRoot = process.cwd()): Promise<void> {
  const paths = statePaths(projectRoot);
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.stateDir, 0o700);
  const allowIndex = args.indexOf('--allow-host');
  if (allowIndex >= 0) {
    if (!args[allowIndex + 1]) throw new Error('--allow-host requires a hostname or *.domain');
    addAllowedHost(args[allowIndex + 1], projectRoot);
  }
  const port = await configuredPort(projectRoot);
  const name = containerName(projectRoot);
  const modelHost = readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_MODEL_HOST || DEFAULT_MODEL_HOST;
  ensureCA(projectRoot);
  ensureSecretsFile(projectRoot);
  writeConfig(projectRoot, port, modelHost);
  upsertEnvVar('NANOCLAW_IRON_PROXY_PORT', String(port), projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_CONTAINER', name, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_CA_CERT', paths.caCert, projectRoot);
  if (!readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_AUTH_ENV) {
    upsertEnvVar('NANOCLAW_IRON_PROXY_AUTH_ENV', 'ANTHROPIC_API_KEY', projectRoot);
  }
  await startProxy(projectRoot);
  console.log(`Iron Proxy ready on install-owned port ${port}.`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void run(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
