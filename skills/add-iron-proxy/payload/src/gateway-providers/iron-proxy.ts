import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import { readEnvFile } from '../env.js';
import { getInstallSlug } from '../install-slug.js';

import {
  registerGatewayProvider,
  type GatewayContribution,
  type GatewayProvider,
  type GatewaySession,
  type GatewaySessionInput,
} from './gateway-provider-registry.js';

const SETTINGS = [
  'NANOCLAW_IRON_PROXY_PORT',
  'NANOCLAW_IRON_PROXY_CONTAINER',
  'NANOCLAW_IRON_PROXY_CA_CERT',
  'NANOCLAW_IRON_PROXY_AUTH_ENV',
  'ANTHROPIC_BASE_URL',
] as const;

const AUTH_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
const CA_CONTAINER_PATH = '/run/nanoclaw-gateway/iron-proxy-ca.crt';
const PLACEHOLDER = 'gateway-managed';

export interface IronProxySettings {
  port: number;
  containerName: string;
  caCert: string;
  authEnv: string;
  anthropicBaseUrl?: string;
}

export function readIronProxySettings(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
): IronProxySettings {
  const file = readEnvFile([...SETTINGS]);
  const value = (key: (typeof SETTINGS)[number]): string => env[key]?.trim() || file[key]?.trim() || '';
  const port = Number(value('NANOCLAW_IRON_PROXY_PORT'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Iron Proxy is not configured: NANOCLAW_IRON_PROXY_PORT must be a valid unprivileged port');
  }
  const authEnv = value('NANOCLAW_IRON_PROXY_AUTH_ENV') || 'ANTHROPIC_API_KEY';
  if (!AUTH_ENV_KEYS.has(authEnv)) throw new Error(`Iron Proxy auth env is unsupported: ${authEnv}`);
  const containerName = value('NANOCLAW_IRON_PROXY_CONTAINER') || `nanoclaw-iron-proxy-${getInstallSlug(projectRoot)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(containerName)) throw new Error('Iron Proxy container name is invalid');
  return {
    port,
    containerName,
    caCert:
      value('NANOCLAW_IRON_PROXY_CA_CERT') || path.join(projectRoot, 'data', 'gateways', 'iron-proxy', 'ca.crt'),
    authEnv,
    ...(value('ANTHROPIC_BASE_URL') ? { anthropicBaseUrl: value('ANTHROPIC_BASE_URL') } : {}),
  };
}

export function ironProxyContribution(settings: IronProxySettings, groupScope: string): GatewayContribution {
  const proxy = `http://host.docker.internal:${settings.port}`;
  return {
    env: {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      NODE_EXTRA_CA_CERTS: CA_CONTAINER_PATH,
      SSL_CERT_FILE: CA_CONTAINER_PATH,
      CURL_CA_BUNDLE: CA_CONTAINER_PATH,
      GIT_SSL_CAINFO: CA_CONTAINER_PATH,
      [settings.authEnv]: PLACEHOLDER,
      ...(settings.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: settings.anthropicBaseUrl } : {}),
    },
    mounts: [
      {
        class: 'allowlisted-extra',
        hostPath: settings.caCert,
        containerPath: CA_CONTAINER_PATH,
        mode: 'ro',
        groupScope,
      },
    ],
  };
}

type Timer = ReturnType<typeof setInterval>;

export interface IronProxyDeps {
  settings(): IronProxySettings;
  isRunning(containerName: string): boolean;
  setInterval(callback: () => void, ms: number): Timer;
  clearInterval(timer: Timer): void;
}

const defaultDeps: IronProxyDeps = {
  settings: readIronProxySettings,
  isRunning(containerName) {
    try {
      return (
        execFileSync(CONTAINER_RUNTIME_BIN, ['inspect', '--format', '{{.State.Running}}', containerName], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5_000,
        }).trim() === 'true'
      );
    } catch {
      return false;
    }
  },
  setInterval,
  clearInterval,
};

export class IronProxyProvider implements GatewayProvider {
  readonly kind = 'iron-proxy';
  readonly networkAccess;
  readonly #settings: IronProxySettings;
  readonly #unavailable = new Map<string, (reason?: string) => void>();
  #timer: Timer | undefined;

  constructor(private readonly deps: IronProxyDeps = defaultDeps) {
    this.#settings = deps.settings();
    this.networkAccess = {
      endpoint: 'host.docker.internal',
      target: { kind: 'container' as const, name: this.#settings.containerName },
    };
  }

  ensureReady(): void {
    if (!fs.existsSync(this.#settings.caCert)) throw new Error(`Iron Proxy CA is missing: ${this.#settings.caCert}`);
    if (!this.deps.isRunning(this.#settings.containerName)) {
      throw new Error(`Iron Proxy container is not running: ${this.#settings.containerName}`);
    }
  }

  startHost(): void {
    if (this.#timer) return;
    this.#timer = this.deps.setInterval(() => {
      if (this.deps.isRunning(this.#settings.containerName)) return;
      for (const callback of this.#unavailable.values()) callback('Iron Proxy became unavailable');
      this.#unavailable.clear();
    }, 2_000);
    this.#timer.unref?.();
  }

  stopHost(): void {
    if (this.#timer) this.deps.clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unavailable.clear();
  }

  async prepareSession(input: GatewaySessionInput): Promise<GatewaySession> {
    return this.#openSession(input);
  }

  async adoptSession(input: GatewaySessionInput): Promise<GatewaySession> {
    return this.#openSession(input);
  }

  #openSession({ key }: GatewaySessionInput): GatewaySession {
    this.ensureReady();
    return {
      contribution: ironProxyContribution(this.#settings, key.agentGroupId),
      onUnavailable: (callback) => this.#unavailable.set(key.sessionId, callback),
      detach: () => this.#unavailable.delete(key.sessionId),
      release: () => this.#unavailable.delete(key.sessionId),
    };
  }
}

registerGatewayProvider({
  kind: 'iron-proxy',
  agentSkills: ['iron-proxy-gateway'],
  create: () => new IronProxyProvider(),
});
