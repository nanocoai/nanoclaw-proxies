import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalRequest } from '@onecli-sh/sdk';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import type { PendingApproval } from '../../types.js';

const state = vi.hoisted(() => ({
  callback: null as null | ((request: ApprovalRequest) => Promise<'approve' | 'deny'>),
  rows: new Map<string, PendingApproval>(),
  failRead: false,
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    configureManualApproval(callback: (request: ApprovalRequest) => Promise<'approve' | 'deny'>) {
      state.callback = callback;
      return { stop: vi.fn() };
    }
  },
}));
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: async () => ({ id: 'g1', name: 'Group One' }) }));
vi.mock('./primitive.js', () => ({
  pickApprover: async () => ['slack:owner'],
  pickApprovalDelivery: async () => ({
    userId: 'slack:owner',
    messagingGroup: { channel_type: 'slack', platform_id: 'D1', instance: 'slack' },
  }),
}));
vi.mock('./response-handler.js', () => ({ isAuthorizedApprovalClick: async () => true }));
vi.mock('../../db/sessions.js', () => ({
  createPendingApproval: async (row: PendingApproval) => state.rows.set(row.approval_id, row),
  deletePendingApproval: async (id: string) => state.rows.delete(id),
  getPendingApproval: async (id: string) => {
    if (state.failRead) throw new Error('read failed');
    return state.rows.get(id);
  },
  getPendingApprovalsByAction: async (action: string) =>
    [...state.rows.values()].filter((row) => row.action === action),
  transitionPendingApprovalStatus: async (id: string, from: string, to: PendingApproval['status']) => {
    const row = state.rows.get(id);
    if (!row || row.status !== from) return false;
    row.status = to;
    return true;
  },
}));

import {
  handleOneCLIApprovalResponse,
  renderOneCLIApprovalQuestion,
  startOneCLIApprovalHandler,
  stopOneCLIApprovalHandler,
} from './onecli-approvals.js';

const adapter: ChannelDeliveryAdapter = {
  deliver: vi.fn(async () => 'message-1'),
};

function request(expiresAt = new Date(Date.now() + 10_000).toISOString()): ApprovalRequest {
  return {
    id: 'request-1',
    method: 'POST',
    url: 'https://api.example.com/action',
    host: 'api.example.com',
    path: '/action',
    headers: {},
    bodyPreview: null,
    agent: { id: 'agent-1', name: 'Agent One', externalId: 'g1' },
    createdAt: new Date().toISOString(),
    expiresAt,
    timeoutSeconds: 10,
  };
}

async function heldRequest(input = request()): Promise<{ id: string; decision: Promise<'approve' | 'deny'> }> {
  const decision = state.callback!(input);
  await vi.waitFor(() => expect(state.rows.size).toBe(1));
  return { id: [...state.rows.keys()][0], decision };
}

beforeEach(() => {
  state.rows.clear();
  state.failRead = false;
  vi.clearAllMocks();
  startOneCLIApprovalHandler(adapter);
});

afterEach(() => {
  stopOneCLIApprovalHandler();
  vi.useRealTimers();
});

describe('OneCLI approval bridge', () => {
  it('holds, renders, and forwards an authorized decision exactly once', async () => {
    const held = await heldRequest();
    let settled = false;
    held.decision.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(renderOneCLIApprovalQuestion(held.id)).resolves.toMatchObject({ title: 'Credentials Request' });

    await expect(
      handleOneCLIApprovalResponse({
        questionId: held.id,
        value: 'approve',
        userId: 'slack:owner',
        channelType: 'slack',
        platformId: 'D1',
        threadId: null,
      }),
    ).resolves.toBe(true);
    await expect(held.decision).resolves.toBe('approve');
    expect(state.rows.size).toBe(0);
  });

  it('denies on handler failure, timeout, and restart', async () => {
    const failed = await heldRequest();
    state.failRead = true;
    await handleOneCLIApprovalResponse({
      questionId: failed.id,
      value: 'approve',
      userId: 'slack:owner',
      channelType: 'slack',
      platformId: 'D1',
      threadId: null,
    });
    await expect(failed.decision).resolves.toBe('deny');

    state.failRead = false;
    vi.useFakeTimers();
    const timedOut = await heldRequest(request(new Date(Date.now() + 2_000).toISOString()));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timedOut.decision).resolves.toBe('deny');
    vi.useRealTimers();

    const restarted = await heldRequest();
    stopOneCLIApprovalHandler();
    await expect(restarted.decision).resolves.toBe('deny');
  });
});
