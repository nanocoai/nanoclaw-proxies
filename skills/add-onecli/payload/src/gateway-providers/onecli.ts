/**
 * OneCLI — the built-in gateway provider.
 *
 * The same wiring the spawn path always did (ensure the agent exists
 * gateway-side, fetch the per-session container config, treat "not applied" as
 * a transient hard failure), with one change: the contribution crosses into
 * the spec as TYPED env and mounts, merged before validation, instead of raw
 * docker flags appended after it.
 *
 * The SDK's apply surface still emits argv, so this provider parses it at the
 * boundary. The grammar is closed and known from the SDK source: with
 * `addHostMapping: false` it emits exactly `-e KEY=VALUE` pairs (proxy env,
 * CA bundle pointers) and `-v host:container[:ro]` mounts (the CA
 * certificate, credential stub FILES — stubs never ride env). Anything else
 * refuses the spawn: nothing gets to ride raw argv around the spec again. A
 * typed SDK config surface is the successor that deletes this parser.
 */
import { OneCLI } from '@onecli-sh/sdk';

import type { MountSpec } from '../drivers/types.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import {
  handleOneCLIApprovalResponse,
  renderOneCLIApprovalQuestion,
  startOneCLIApprovalHandler,
  stopOneCLIApprovalHandler,
} from '../modules/approvals/onecli-approvals.js';

import {
  registerGatewayProvider,
  type GatewayContribution,
  type GatewaySession,
  type GatewaySessionInput,
} from './gateway-provider-registry.js';
import { onecliUninstall } from './onecli-uninstall.js';

const env = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY', 'ONECLI_GATEWAY_CONTAINER', 'ANTHROPIC_BASE_URL']);
const onecliUrl = process.env.ONECLI_URL || env.ONECLI_URL;
const onecliApiKey = process.env.ONECLI_API_KEY || env.ONECLI_API_KEY;
const gatewayContainer = process.env.ONECLI_GATEWAY_CONTAINER || env.ONECLI_GATEWAY_CONTAINER || 'onecli';
const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL;
const onecli = new OneCLI({ url: onecliUrl, apiKey: onecliApiKey });
const healthUrl = new URL('/v1/health', onecliUrl || 'https://api.onecli.sh').toString();
const liveLeases = new Set<{
  closed: boolean;
  unavailable?: string;
  notify?: (reason?: string) => void;
}>();
let healthTimer: NodeJS.Timeout | null = null;
let probing = false;

type OneCLIContribution = Omit<GatewayContribution, 'networkAccess'>;

/** Argv → typed contribution. Exported for its tests; the grammar is closed. */
export function contributionFromArgs(args: readonly string[], groupScope: string): OneCLIContribution {
  const env: Record<string, string> = {};
  const mounts: MountSpec[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '-e' && value?.includes('=')) {
      const eq = value.indexOf('=');
      env[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    if (flag === '-v' && value) {
      const parts = value.split(':');
      if (parts.length >= 2 && parts.length <= 3 && (parts[2] === undefined || parts[2] === 'ro')) {
        mounts.push({
          class: 'allowlisted-extra',
          hostPath: parts[0],
          containerPath: parts[1],
          mode: parts[2] === 'ro' ? 'ro' : 'rw',
          groupScope,
        });
        continue;
      }
    }
    // Fail-closed on grammar drift: an SDK that starts emitting a flag this
    // parser cannot type must break the spawn loudly, not smuggle argv.
    throw new Error(`OneCLI gateway emitted argv this seam cannot type: '${flag} ${value ?? ''}'`);
  }
  return { env, mounts };
}

export function withProviderEnv(contribution: OneCLIContribution, baseUrl = anthropicBaseUrl): OneCLIContribution {
  if (!baseUrl) return contribution;
  return {
    ...contribution,
    env: {
      ...contribution.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: 'gateway-managed',
    },
  };
}

function stopHealthMonitor(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

async function probeHealth(): Promise<void> {
  if (probing || liveLeases.size === 0) return;
  probing = true;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`status ${response.status}`);
  } catch (err) {
    const reason = 'OneCLI gateway unavailable';
    log.error(reason, { err });
    stopHealthMonitor();
    for (const lease of liveLeases) {
      lease.unavailable = reason;
      lease.notify?.(reason);
    }
  } finally {
    probing = false;
  }
}

function monitorLease(): Pick<GatewaySession, 'onUnavailable' | 'detach' | 'release'> {
  const lease: { closed: boolean; unavailable?: string; notify?: (reason?: string) => void } = { closed: false };
  liveLeases.add(lease);
  if (!healthTimer) {
    healthTimer = setInterval(() => void probeHealth(), 5_000);
    healthTimer.unref();
  }
  const close = () => {
    if (lease.closed) return;
    lease.closed = true;
    liveLeases.delete(lease);
    if (liveLeases.size === 0) stopHealthMonitor();
  };
  return {
    onUnavailable(callback) {
      lease.notify = callback;
      if (lease.unavailable) callback(lease.unavailable);
    },
    detach: close,
    release: close,
  };
}

async function openSession({ key, groupName }: GatewaySessionInput): Promise<GatewaySession> {
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  await onecli.ensureAgent({ name: groupName, identifier: key.agentGroupId });
  const args: string[] = [];
  const applied = await onecli.applyContainerConfig(args, {
    addHostMapping: false,
    agent: key.agentGroupId,
  });
  if (!applied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', {
    agentGroupId: key.agentGroupId,
    sessionId: key.sessionId,
  });
  return {
    ...monitorLease(),
    contribution: {
      ...withProviderEnv(contributionFromArgs(args, key.agentGroupId)),
      networkAccess: {
        endpoint: 'host.docker.internal',
        target: { kind: 'runtime', identity: gatewayContainer },
      },
    },
  };
}

registerGatewayProvider({
  kind: 'onecli',
  agentSkills: ['onecli-gateway'],
  create: () => ({
    kind: 'onecli',
    approvalBridge: {
      start: ({ deliveryAdapter }) => startOneCLIApprovalHandler(deliveryAdapter),
      stop: stopOneCLIApprovalHandler,
      handleResponse: handleOneCLIApprovalResponse,
      renderQuestion: renderOneCLIApprovalQuestion,
    },
    uninstall: onecliUninstall,
    prepareSession: openSession,
    adoptSession: openSession,
  }),
});
