import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import { IronProxyApprovalBridge, type IronApprovalIdentity } from './iron-proxy-approval.js';
import {
  registerGatewayProvider,
  type GatewayContribution,
  type GatewayProvider,
  type GatewaySession,
  type GatewaySessionInput,
} from './gateway-provider-registry.js';

const SETTINGS = [
  'NANOCLAW_SESSION_MATERIAL_ROOT',
  'NANOCLAW_IRON_PROXY_IMAGE',
  'NANOCLAW_IRON_PROXY_CA_CERT',
  'NANOCLAW_IRON_PROXY_CA_KEY',
  'NANOCLAW_IRON_PROXY_SECRET_FILE',
  'NANOCLAW_IRON_PROXY_APPROVAL_SOCKET',
  'NANOCLAW_IRON_PROXY_AUTH_ENV',
  'NANOCLAW_IRON_PROXY_MODEL_HOST',
  'NANOCLAW_IRON_PROXY_ALLOWED_HOSTS',
  'NANOCLAW_IRON_PROXY_APPROVAL_TIMEOUT_MS',
  'NANOCLAW_IRON_PROXY_MAX_PENDING',
  'ANTHROPIC_BASE_URL',
] as const;

const AUTH_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
const PLACEHOLDER = 'gateway-managed';
const PROXY_ROLE = 'gateway-proxy';
const PROXY_HOST = 'iron-proxy';
const PROXY_PORT = 8080;
const CONFIG_PATH = '/etc/iron-proxy/config.yaml';
const CA_CERT_PATH = '/etc/iron-proxy/ca.crt';
const CA_KEY_PATH = '/etc/iron-proxy/ca.key';
const SECRET_PATH = '/run/secrets/upstream';
const APPROVAL_DIR = '/run/nanoclaw-gateway';
const APPROVAL_SOCKET = `${APPROVAL_DIR}/approval.sock`;
const AGENT_CA_PATH = '/home/node/.claude/skills/iron-proxy-gateway/ca.crt';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export interface IronProxySettings {
  materialRoot: string;
  image: string;
  caCert: string;
  caKey: string;
  secretFile: string;
  approvalSocket: string;
  agentCaCert: string;
  allowedHostsFile: string;
  authEnv: string;
  modelHost: string;
  anthropicBaseUrl?: string;
  approvalTimeoutMs: number;
  maxPending: number;
}

function valueIn(env: NodeJS.ProcessEnv, file: Record<string, string>, key: (typeof SETTINGS)[number]): string {
  return env[key]?.trim() || file[key]?.trim() || '';
}

function integerSetting(raw: string, fallback: number, min: number, max: number, name: string): number {
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function assertMaterialPath(file: string, root: string, label: string): void {
  const relative = path.relative(root, file);
  if (!path.isAbsolute(file) || relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Iron Proxy ${label} must be inside NANOCLAW_SESSION_MATERIAL_ROOT`);
  }
}

export function validateAllowedHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw new Error(`Invalid Iron Proxy host: ${raw}`);
  }
  return host;
}

export function readIronProxySettings(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
): IronProxySettings {
  const file = readEnvFile([...SETTINGS]);
  const value = (key: (typeof SETTINGS)[number]): string => valueIn(env, file, key);
  const materialRoot = value('NANOCLAW_SESSION_MATERIAL_ROOT') || path.join(projectRoot, 'data', 'session-materials');
  const gatewayRoot = path.join(materialRoot, 'iron-proxy');
  const image = value('NANOCLAW_IRON_PROXY_IMAGE');
  if (!/^ghcr\.io\/[a-z0-9._/-]+(?::[a-z0-9._-]+)?@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error('Iron Proxy image must be an exact GHCR digest');
  }
  const authEnv = value('NANOCLAW_IRON_PROXY_AUTH_ENV') || 'ANTHROPIC_API_KEY';
  if (!AUTH_ENV_KEYS.has(authEnv)) throw new Error(`Iron Proxy auth env is unsupported: ${authEnv}`);
  const settings: IronProxySettings = {
    materialRoot,
    image,
    caCert: value('NANOCLAW_IRON_PROXY_CA_CERT') || path.join(gatewayRoot, 'shared', 'ca.crt'),
    caKey: value('NANOCLAW_IRON_PROXY_CA_KEY') || path.join(gatewayRoot, 'shared', 'ca.key'),
    secretFile: value('NANOCLAW_IRON_PROXY_SECRET_FILE') || path.join(gatewayRoot, 'shared', 'upstream-secret'),
    approvalSocket: value('NANOCLAW_IRON_PROXY_APPROVAL_SOCKET') || path.join(gatewayRoot, 'approval', 'approval.sock'),
    agentCaCert: path.join(projectRoot, 'container', 'skills', 'iron-proxy-gateway', 'ca.crt'),
    allowedHostsFile:
      value('NANOCLAW_IRON_PROXY_ALLOWED_HOSTS') || path.join(gatewayRoot, 'shared', 'allowed-hosts.json'),
    authEnv,
    modelHost: validateAllowedHost(value('NANOCLAW_IRON_PROXY_MODEL_HOST') || 'api.anthropic.com'),
    ...(value('ANTHROPIC_BASE_URL') ? { anthropicBaseUrl: value('ANTHROPIC_BASE_URL') } : {}),
    approvalTimeoutMs: integerSetting(
      value('NANOCLAW_IRON_PROXY_APPROVAL_TIMEOUT_MS'),
      120_000,
      5_000,
      300_000,
      'NANOCLAW_IRON_PROXY_APPROVAL_TIMEOUT_MS',
    ),
    maxPending: integerSetting(value('NANOCLAW_IRON_PROXY_MAX_PENDING'), 32, 1, 128, 'NANOCLAW_IRON_PROXY_MAX_PENDING'),
  };
  for (const [label, materialPath] of Object.entries({
    caCert: settings.caCert,
    caKey: settings.caKey,
    secretFile: settings.secretFile,
    approvalSocket: settings.approvalSocket,
    allowedHostsFile: settings.allowedHostsFile,
  })) {
    assertMaterialPath(materialPath, materialRoot, label);
  }
  return settings;
}

function readAllowedHosts(settings: IronProxySettings): string[] {
  if (!fs.existsSync(settings.allowedHostsFile)) return [];
  const value = JSON.parse(fs.readFileSync(settings.allowedHostsFile, 'utf8')) as unknown;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Invalid Iron Proxy allowed-hosts file: ${settings.allowedHostsFile}`);
  }
  return [...new Set(value.map(validateAllowedHost))].sort();
}

/** One rule object feeds approval matching and secret matching, so they cannot drift. */
export function ironProxyConfig(settings: IronProxySettings, runtimeIdentity: string): string {
  const credentialRules = [{ host: settings.modelHost, methods: METHODS }];
  const allowedHosts = [...new Set([settings.modelHost, ...readAllowedHosts(settings)])].sort();
  return stringifyYaml(
    {
      dns: { enabled: false },
      proxy: { tunnel_listen: `:${PROXY_PORT}`, upstream_response_header_timeout: '5m' },
      tls: { mode: 'mitm', ca_cert: CA_CERT_PATH, ca_key: CA_KEY_PATH },
      transforms: [
        { name: 'allowlist', config: { domains: allowedHosts } },
        {
          name: 'grpc',
          config: {
            name: 'nanoclaw-approval',
            target: `unix://${APPROVAL_SOCKET}`,
            workload_identity: runtimeIdentity,
            send_request_body: false,
            send_response_body: false,
            rules: credentialRules,
          },
        },
        {
          name: 'secrets',
          config: {
            secrets: [
              {
                source: { type: 'file', path: SECRET_PATH, ttl: '1s', failure_ttl: '1s' },
                replace: {
                  proxy_value: PLACEHOLDER,
                  match_headers: ['Authorization', 'x-api-key'],
                  require: true,
                },
                rules: credentialRules,
              },
            ],
          },
        },
      ],
      log: { level: 'info' },
    },
    { lineWidth: 0 },
  );
}

function materialId(runtimeIdentity: string): string {
  return createHash('sha256').update(runtimeIdentity).digest('hex');
}

function sessionMaterialDir(settings: IronProxySettings, runtimeIdentity: string): string {
  return path.join(settings.materialRoot, 'iron-proxy', 'sessions', materialId(runtimeIdentity));
}

function writeSessionMaterial(settings: IronProxySettings, input: GatewaySessionInput): string {
  const dir = sessionMaterialDir(settings, input.runtimeIdentity);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = path.join(dir, 'config.yaml');
  const temp = `${config}.tmp`;
  fs.writeFileSync(temp, ironProxyConfig(settings, input.runtimeIdentity), { mode: 0o600 });
  fs.renameSync(temp, config);
  fs.writeFileSync(
    path.join(dir, 'owner.json'),
    `${JSON.stringify({ runtimeIdentity: input.runtimeIdentity, key: input.key })}\n`,
    { mode: 0o600 },
  );
  return config;
}

function assertReady(settings: IronProxySettings, bridge: IronProxyApprovalBridge): void {
  if (!bridge.running) throw new Error('Iron Proxy approval bridge is not running');
  for (const file of [settings.caCert, settings.caKey, settings.secretFile, settings.agentCaCert]) {
    if (!fs.existsSync(file)) throw new Error(`Iron Proxy prerequisite is missing: ${file}`);
  }
}

export function ironProxyContribution(
  settings: IronProxySettings,
  input: GatewaySessionInput,
  configFile: string,
): GatewayContribution {
  const proxy = `http://${PROXY_HOST}:${PROXY_PORT}`;
  const scope = input.key.agentGroupId;
  const materialMount = (hostPath: string, containerPath: string) => ({
    class: 'identity-material' as const,
    hostPath,
    containerPath,
    mode: 'ro' as const,
    groupScope: scope,
  });
  return {
    env: {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      NODE_EXTRA_CA_CERTS: AGENT_CA_PATH,
      SSL_CERT_FILE: AGENT_CA_PATH,
      CURL_CA_BUNDLE: AGENT_CA_PATH,
      GIT_SSL_CAINFO: AGENT_CA_PATH,
      [settings.authEnv]: PLACEHOLDER,
      ...(settings.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: settings.anthropicBaseUrl } : {}),
    },
    labels: { 'nanoclaw.gateway.runtime-identity': materialId(input.runtimeIdentity) },
    containers: [
      {
        role: PROXY_ROLE,
        image: settings.image,
        env: {},
        mounts: [
          materialMount(configFile, CONFIG_PATH),
          materialMount(settings.caCert, CA_CERT_PATH),
          materialMount(settings.caKey, CA_KEY_PATH),
          materialMount(settings.secretFile, SECRET_PATH),
          materialMount(path.dirname(settings.approvalSocket), APPROVAL_DIR),
        ],
        labels: { 'nanoclaw.gateway.runtime-identity': materialId(input.runtimeIdentity) },
        args: ['-config', CONFIG_PATH],
      },
    ],
    networkAccess: { endpoint: PROXY_HOST, target: { kind: 'session-container', role: PROXY_ROLE } },
  };
}

interface LiveLease extends IronApprovalIdentity {
  unavailable?: string;
  notify?: (reason?: string) => void;
}

export class IronProxyProvider implements GatewayProvider {
  readonly kind = 'iron-proxy';
  readonly #leases = new Map<string, LiveLease>();
  readonly #bridge: IronProxyApprovalBridge;
  #monitor: NodeJS.Timeout | null = null;

  readonly approvalBridge;

  constructor(readonly settings: IronProxySettings = readIronProxySettings()) {
    this.#bridge = new IronProxyApprovalBridge(
      {
        socketPath: settings.approvalSocket,
        timeoutMs: settings.approvalTimeoutMs,
        maxPending: settings.maxPending,
      },
      (runtimeIdentity) => this.#leases.get(runtimeIdentity),
    );
    this.approvalBridge = {
      start: ({ deliveryAdapter }: { deliveryAdapter: import('../delivery.js').ChannelDeliveryAdapter }) =>
        this.#bridge.start(deliveryAdapter),
      stop: () => this.#bridge.stop(),
      handleResponse: (payload: import('../response-registry.js').ResponsePayload) =>
        this.#bridge.handleResponse(payload),
      renderQuestion: (questionId: string) => this.#bridge.renderQuestion(questionId),
    };
  }

  prepareSession(input: GatewaySessionInput): Promise<GatewaySession> {
    return Promise.resolve(this.#openSession(input));
  }

  adoptSession(input: GatewaySessionInput): Promise<GatewaySession> {
    return Promise.resolve(this.#openSession(input));
  }

  async reapResidue(installSlug: string, adopted: readonly GatewaySessionInput['key'][]): Promise<void> {
    const root = path.join(this.settings.materialRoot, 'iron-proxy', 'sessions');
    if (!fs.existsSync(root)) return;
    const live = new Set(adopted.map((key) => `${key.installSlug}\0${key.agentGroupId}\0${key.sessionId}`));
    for (const entry of fs.readdirSync(root)) {
      const dir = path.join(root, entry);
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')) as {
          key?: GatewaySessionInput['key'];
        };
        const key = owner.key;
        if (!key || key.installSlug !== installSlug) continue;
        if (!live.has(`${key.installSlug}\0${key.agentGroupId}\0${key.sessionId}`)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (err) {
        log.warn('Ignoring unrecognized Iron Proxy residue', { dir, err });
      }
    }
  }

  #openSession(input: GatewaySessionInput): GatewaySession {
    if (!input.capabilities.auxiliaryContainers) {
      throw new Error('Selected runtime driver cannot manage the Iron Proxy session container');
    }
    assertReady(this.settings, this.#bridge);
    const configFile = writeSessionMaterial(this.settings, input);
    const lease: LiveLease = {
      runtimeIdentity: input.runtimeIdentity,
      sessionId: input.key.sessionId,
      agentGroupId: input.key.agentGroupId,
      groupName: input.groupName,
    };
    this.#leases.set(input.runtimeIdentity, lease);
    this.#startMonitor();
    const close = async (revoke: boolean): Promise<void> => {
      if (this.#leases.get(input.runtimeIdentity) !== lease) return;
      this.#leases.delete(input.runtimeIdentity);
      await this.#bridge.cancelIdentity(input.runtimeIdentity);
      if (revoke) fs.rmSync(sessionMaterialDir(this.settings, input.runtimeIdentity), { recursive: true, force: true });
      if (this.#leases.size === 0 && this.#monitor) {
        clearInterval(this.#monitor);
        this.#monitor = null;
      }
    };
    return {
      contribution: ironProxyContribution(this.settings, input, configFile),
      onUnavailable(callback) {
        lease.notify = callback;
        if (lease.unavailable) callback(lease.unavailable);
      },
      detach: () => close(false),
      release: () => close(true),
    };
  }

  #startMonitor(): void {
    if (this.#monitor) return;
    this.#monitor = setInterval(() => {
      const missing = [this.settings.caCert, this.settings.caKey, this.settings.secretFile].find(
        (file) => !fs.existsSync(file),
      );
      const reason = !this.#bridge.running
        ? 'Iron Proxy approval bridge unavailable'
        : missing
          ? `Iron Proxy material unavailable: ${missing}`
          : '';
      if (!reason) return;
      clearInterval(this.#monitor!);
      this.#monitor = null;
      for (const lease of this.#leases.values()) {
        lease.unavailable = reason;
        lease.notify?.(reason);
      }
    }, 2_000);
    this.#monitor.unref();
  }
}

registerGatewayProvider({
  kind: 'iron-proxy',
  agentSkills: ['iron-proxy-gateway'],
  create: () => new IronProxyProvider(),
});
