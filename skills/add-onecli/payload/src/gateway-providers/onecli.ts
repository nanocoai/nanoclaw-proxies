/** OneCLI native-protocol adapter for the generic gateway contract. */
import { OneCLI, type ApprovalRequest } from '@onecli-sh/sdk';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import {
  registerGatewayProvider,
  type GatewayApprovalRequest,
  type GatewayContribution,
  type GatewaySessionInput,
  type GatewaySessionLease,
} from './gateway-provider-registry.js';

const env = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY', 'ONECLI_GATEWAY_CONTAINER', 'ANTHROPIC_BASE_URL']);
const onecliUrl = process.env.ONECLI_URL || env.ONECLI_URL;
const onecliApiKey = process.env.ONECLI_API_KEY || env.ONECLI_API_KEY;
const gatewayContainer = process.env.ONECLI_GATEWAY_CONTAINER || env.ONECLI_GATEWAY_CONTAINER || 'onecli';
const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL;
const onecli = new OneCLI({ url: onecliUrl, apiKey: onecliApiKey });
const healthUrl = new URL('/v1/health', onecliUrl || 'https://api.onecli.sh').toString();
const liveLeases = new Set<{ unavailable?: string; notify?: (reason: string) => void }>();
let healthTimer: NodeJS.Timeout | null = null;
let probing = false;

type OneCLIContribution = Omit<GatewayContribution, 'networkAccess'>;
type GatewayMount = NonNullable<GatewayContribution['mounts']>[number];

/** The SDK emits a closed argv grammar; translate it or fail before runtime validation. */
export function contributionFromArgs(args: readonly string[], groupScope: string): OneCLIContribution {
  const env: Record<string, string> = {};
  const mounts: GatewayMount[] = [];
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
    throw new Error(`OneCLI gateway emitted argv this seam cannot type: '${flag} ${value ?? ''}'`);
  }
  return { env, mounts };
}

export function withProviderEnv(contribution: OneCLIContribution, baseUrl = anthropicBaseUrl): OneCLIContribution {
  if (!baseUrl) return contribution;
  return {
    ...contribution,
    env: { ...contribution.env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: 'gateway-managed' },
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

function monitorLease(signal: AbortSignal): Pick<GatewaySessionLease, 'onUnavailable'> {
  const lease: { unavailable?: string; notify?: (reason: string) => void } = {};
  liveLeases.add(lease);
  if (!healthTimer) {
    healthTimer = setInterval(() => void probeHealth(), 5_000);
    healthTimer.unref();
  }
  const close = () => {
    liveLeases.delete(lease);
    if (liveLeases.size === 0) stopHealthMonitor();
  };
  if (signal.aborted) close();
  else signal.addEventListener('abort', close, { once: true });
  return {
    onUnavailable(report) {
      lease.notify = report;
      if (lease.unavailable) report(lease.unavailable);
    },
  };
}

async function ensureSession(input: GatewaySessionInput, signal: AbortSignal): Promise<GatewaySessionLease> {
  await onecli.ensureAgent({ name: input.groupName, identifier: input.key.agentGroupId });
  const args: string[] = [];
  const applied = await onecli.applyContainerConfig(args, {
    addHostMapping: false,
    agent: input.key.agentGroupId,
  });
  if (!applied) throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  return {
    ...monitorLease(signal),
    contribution: {
      ...withProviderEnv(contributionFromArgs(args, input.key.agentGroupId)),
      networkAccess: {
        endpoint: 'host.docker.internal',
        target: { kind: 'runtime', identity: gatewayContainer },
      },
    },
  };
}

async function subscribeApprovals(
  decide: (request: GatewayApprovalRequest) => Promise<'approve' | 'deny'>,
  signal: AbortSignal,
): Promise<void> {
  const subscribedAt = Date.now();
  const handle = onecli.configureManualApproval(async (request: ApprovalRequest) => {
    if (Date.parse(request.createdAt) < subscribedAt) return 'deny';
    try {
      return await decide(toGatewayApprovalRequest(request));
    } catch (err) {
      log.error('OneCLI approval translation failed closed', { requestId: request.id, err });
      return 'deny';
    }
  });
  await new Promise<void>((resolve) => {
    const stop = () => {
      handle.stop();
      resolve();
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

function toGatewayApprovalRequest(request: ApprovalRequest): GatewayApprovalRequest {
  return {
    id: request.id,
    agentGroupId: request.agent.externalId ?? '',
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    title: 'Credentials Request',
    question: buildQuestion(request, request.agent.name),
    audit: { method: request.method, host: request.host, path: request.path },
  };
}

interface ApprovalSummary {
  action?: string;
  details?: { label: string; value: string }[];
}

function buildQuestion(request: ApprovalRequest, agentName: string): string {
  const lines = [`*Agent:* ${agentName}`];
  const summary = (request as ApprovalRequest & { summary?: ApprovalSummary }).summary;
  if (summary?.details?.length) {
    if (summary.action) lines.push(`*Action:* ${summary.action}`);
    let budget = 2_200;
    for (const { label, value } of summary.details) {
      if (budget <= 0) break;
      const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
      const shown = raw.slice(0, Math.min(900, budget));
      lines.push(shown.includes('\n') ? `*${label}:*\n\`\`\`\n${shown}\n\`\`\`` : `*${label}:* ${shown}`);
      budget -= shown.length + String(label).length + 8;
    }
  } else if (request.bodyPreview) {
    lines.push('```', request.bodyPreview.slice(0, 1_800), '```');
    lines.push(`_${request.method} ${request.host}${request.path}_`);
  } else {
    lines.push(`_${request.method} ${request.host}${request.path}_`);
  }
  return lines.join('\n').slice(0, 2_600);
}

registerGatewayProvider({
  kind: 'onecli',
  agentSkills: ['onecli-gateway'],
  sessions: {
    ensure: ensureSession,
    listOwned: async () => [],
    revoke: async () => {},
  },
  approvals: { subscribe: subscribeApprovals },
});
