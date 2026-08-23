import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import type { GatewaySessionInput } from './gateway-provider-registry.js';

vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  defineIronProxyProvider,
  ironProxyConfig,
  ironProxyContribution,
  readIronProxySettings,
  type IronProxySettings,
} from './iron-proxy.js';

const digest = `ghcr.io/nanocoai/iron-proxy@sha256:${'a'.repeat(64)}`;
const root = '/tmp/nanoclaw-iron-test';
const materialRoot = path.join(root, 'data', 'session-materials');
const settings: IronProxySettings = {
  materialRoot,
  image: digest,
  caCert: path.join(materialRoot, 'iron-proxy/shared/ca.crt'),
  caKey: path.join(materialRoot, 'iron-proxy/shared/ca.key'),
  secretFile: path.join(materialRoot, 'iron-proxy/shared/upstream-secret'),
  approvalSocket: path.join(materialRoot, 'iron-proxy/approval/approval.sock'),
  agentCaCert: path.join(root, 'container/skills/iron-proxy-gateway/ca.crt'),
  allowedHostsFile: path.join(materialRoot, 'iron-proxy/shared/allowed-hosts.json'),
  authEnv: 'ANTHROPIC_API_KEY',
  modelHost: 'api.anthropic.com',
  approvalTimeoutMs: 120_000,
  maxPending: 32,
};
const input: GatewaySessionInput = {
  key: { installSlug: 'install', agentGroupId: 'group', sessionId: 'session' },
  runtimeIdentity: 'install/group/session',
  groupName: 'Group',
  capabilities: {
    isolationTiers: ['container'],
    admissionEnforced: false,
    networkPolicy: 'topology' as const,
    encryptedVolumes: false,
    unrealized: [],
    sharedNetworkNamespace: false,
    auxiliaryContainers: true,
    imageBuild: true,
  },
};

describe('Iron Proxy provider', () => {
  it('renders allowlist, approval, then secret injection from one credential rule', () => {
    const config = parseYaml(ironProxyConfig(settings, input.runtimeIdentity));
    expect(config.transforms.map((entry: { name: string }) => entry.name)).toEqual(['allowlist', 'grpc', 'secrets']);
    expect(config.transforms[1].config.rules).toEqual(config.transforms[2].config.secrets[0].rules);
    expect(config.transforms[1].config.rules[0].methods).not.toContain('CONNECT');
    expect(config.transforms[1].config).toMatchObject({
      target: 'unix:///run/nanoclaw-gateway/approval.sock',
      workload_identity: input.runtimeIdentity,
      send_request_body: false,
    });
    expect(config.transforms[2].config.secrets[0].source.path).toBe('/run/secrets/upstream');
  });

  it('contributes one isolated proxy, typed material, and no credential mount to the agent', () => {
    const configFile = path.join(materialRoot, 'iron-proxy/sessions/id/config.yaml');
    const contribution = ironProxyContribution(settings, input, configFile);
    expect(contribution.networkAccess).toEqual({
      endpoint: 'iron-proxy',
      target: { kind: 'session-container', role: 'gateway-proxy' },
    });
    expect(contribution.mounts).toBeUndefined();
    expect(contribution.env).toMatchObject({
      HTTPS_PROXY: 'http://iron-proxy:8080',
      ANTHROPIC_API_KEY: 'gateway-managed',
      NODE_EXTRA_CA_CERTS: '/home/node/.claude/skills/iron-proxy-gateway/ca.crt',
    });
    expect(contribution.containers).toHaveLength(1);
    expect(contribution.containers?.[0]).toMatchObject({ role: 'gateway-proxy', image: digest, env: {} });
    expect(contribution.containers?.[0].mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostPath: settings.secretFile, class: 'identity-material', mode: 'ro' }),
        expect.objectContaining({ hostPath: path.dirname(settings.approvalSocket), class: 'identity-material' }),
      ]),
    );
  });

  it('requires an immutable image and keeps every private path under the material root', () => {
    expect(() => readIronProxySettings({ NANOCLAW_IRON_PROXY_IMAGE: 'ironsh/iron-proxy:latest' }, root)).toThrow(
      /exact GHCR digest/,
    );
    expect(() =>
      readIronProxySettings(
        {
          NANOCLAW_IRON_PROXY_IMAGE: digest,
          NANOCLAW_IRON_PROXY_SECRET_FILE: '/tmp/outside-secret',
        },
        root,
      ),
    ).toThrow(/inside NANOCLAW_SESSION_MATERIAL_ROOT/);
  });

  it('uses one idempotent ensure, preserves on abort, and revokes only explicitly', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-'));
    const liveSettings: IronProxySettings = {
      ...settings,
      materialRoot: path.join(project, 'materials'),
      caCert: path.join(project, 'materials/iron-proxy/shared/ca.crt'),
      caKey: path.join(project, 'materials/iron-proxy/shared/ca.key'),
      secretFile: path.join(project, 'materials/iron-proxy/shared/upstream-secret'),
      approvalSocket: path.join(project, 'materials/iron-proxy/approval/approval.sock'),
      allowedHostsFile: path.join(project, 'materials/iron-proxy/shared/allowed-hosts.json'),
      agentCaCert: path.join(project, 'container/skills/iron-proxy-gateway/ca.crt'),
    };
    for (const file of [liveSettings.caCert, liveSettings.caKey, liveSettings.secretFile, liveSettings.agentCaCert]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'test');
    }

    const provider = defineIronProxyProvider(liveSettings);
    const approvalController = new AbortController();
    const subscription = provider.approvals.subscribe(async () => 'deny', approvalController.signal);
    const firstController = new AbortController();
    const first = await provider.sessions.ensure(input, firstController.signal);
    const configFile = first.contribution.containers?.[0].mounts[0].hostPath as string;
    expect(fs.existsSync(configFile)).toBe(true);
    firstController.abort();
    expect(fs.existsSync(configFile)).toBe(true);

    const secondController = new AbortController();
    const second = await provider.sessions.ensure(input, secondController.signal);
    expect(second.owned).toEqual(first.owned);
    await expect(provider.sessions.listOwned('install')).resolves.toEqual([first.owned]);

    const unavailable = vi.fn();
    second.onUnavailable?.(unavailable);
    fs.rmSync(liveSettings.secretFile);
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalled(), { timeout: 3_000 });
    secondController.abort();
    await provider.sessions.revoke(second.owned!, 'session ended');
    expect(fs.existsSync(path.dirname(configFile))).toBe(false);

    approvalController.abort();
    await subscription;
    fs.rmSync(project, { recursive: true, force: true });
  });
});
