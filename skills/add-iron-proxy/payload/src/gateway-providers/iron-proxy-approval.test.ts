import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDeliveryAdapter } from '../delivery.js';
import type { PendingApproval } from '../types.js';

const state = vi.hoisted(() => ({
  rows: new Map<string, PendingApproval>(),
  authorized: true,
  failRead: false,
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../modules/approvals/primitive.js', () => ({
  pickApprover: async () => ['slack:owner'],
  pickApprovalDelivery: async () => ({
    userId: 'slack:owner',
    messagingGroup: { channel_type: 'slack', platform_id: 'D1', instance: 'slack' },
  }),
}));
vi.mock('../modules/approvals/response-handler.js', () => ({
  isAuthorizedApprovalClick: async () => state.authorized,
}));
vi.mock('../db/sessions.js', () => ({
  createPendingApproval: async (row: PendingApproval) => {
    if (state.rows.has(row.approval_id)) return false;
    state.rows.set(row.approval_id, row);
    return true;
  },
  deletePendingApproval: async (id: string) => state.rows.delete(id),
  getPendingApproval: async (id: string) => {
    if (state.failRead) throw new Error('read failed');
    return state.rows.get(id);
  },
  getPendingApprovalsByAction: async (action: string) =>
    [...state.rows.values()].filter((row) => row.action === action),
  getSession: async () => ({ id: 'session', agent_group_id: 'group', status: 'active' }),
  transitionPendingApprovalStatus: async (id: string, from: string, to: PendingApproval['status']) => {
    const row = state.rows.get(id);
    if (!row || row.status !== from) return false;
    row.status = to;
    return true;
  },
}));

import {
  IRON_PROXY_IDENTITY_METADATA,
  IronProxyApprovalBridge,
  type IronApprovalIdentity,
} from './iron-proxy-approval.js';

interface TransformClient extends grpc.Client {
  transformRequest(
    request: Record<string, unknown>,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: { action: number }) => void,
  ): grpc.ClientUnaryCall;
}

const identity: IronApprovalIdentity = {
  runtimeIdentity: 'install/group/session',
  sessionId: 'session',
  agentGroupId: 'group',
  groupName: 'Group One',
};
const adapter: ChannelDeliveryAdapter = { deliver: vi.fn(async () => 'message-1') };
let root: string;
let bridge: IronProxyApprovalBridge;
let client: TransformClient;

function metadata(runtimeIdentity = identity.runtimeIdentity): grpc.Metadata {
  const value = new grpc.Metadata();
  value.set(IRON_PROXY_IDENTITY_METADATA, runtimeIdentity);
  return value;
}

function transform(
  request: Record<string, unknown> = {
    request: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages?private=query',
      host: 'api.anthropic.com',
      headers: { Authorization: { values: ['Bearer gateway-managed'] } },
      body: Buffer.from('private body'),
    },
  },
  requestMetadata = metadata(),
): Promise<{ action: number }> {
  return new Promise((resolve, reject) => {
    client.transformRequest(request, requestMetadata, (error, response) => (error ? reject(error) : resolve(response)));
  });
}

function response(questionId: string, value: string) {
  return {
    questionId,
    value,
    userId: 'slack:owner',
    channelType: 'slack',
    platformId: 'D1',
    threadId: null,
  };
}

async function heldRequest(): Promise<{ id: string; decision: Promise<{ action: number }> }> {
  const decision = transform();
  await vi.waitFor(() => expect(state.rows.size).toBe(1));
  return { id: [...state.rows.keys()][0], decision };
}

beforeEach(async () => {
  state.rows.clear();
  state.authorized = true;
  state.failRead = false;
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-approval-'));
  const protoPath = path.join(process.cwd(), 'src', 'gateway-providers', 'iron-proxy-transform.proto');
  bridge = new IronProxyApprovalBridge(
    { socketPath: path.join(root, 'approval.sock'), timeoutMs: 100, maxPending: 1, protoPath },
    (runtimeIdentity) => (runtimeIdentity === identity.runtimeIdentity ? identity : undefined),
  );
  await bridge.start(adapter);
  const definition = protoLoader.loadSync(protoPath, { defaults: true, enums: Number });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    transform: { v1: { TransformService: grpc.ServiceClientConstructor } };
  };
  client = new loaded.transform.v1.TransformService(
    `unix:${path.join(root, 'approval.sock')}`,
    grpc.credentials.createInsecure(),
  ) as unknown as TransformClient;
});

afterEach(async () => {
  client.close();
  await bridge.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Iron Proxy approval bridge', () => {
  it('holds before injection, renders a privacy-safe card, and forwards exactly once', async () => {
    const held = await heldRequest();
    let settled = false;
    held.decision.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(bridge.renderQuestion(held.id)).resolves.toMatchObject({ title: 'Network credentials request' });
    const card = JSON.parse(vi.mocked(adapter.deliver).mock.calls[0][4] as string) as { question: string };
    expect(card.question).toContain('POST api.anthropic.com/v1/messages');
    expect(card.question).not.toContain('private=query');
    expect(card.question).not.toContain('gateway-managed');
    expect(card.question).not.toContain('private body');

    await expect(bridge.handleResponse(response(held.id, 'approve'))).resolves.toBe(true);
    await expect(held.decision).resolves.toMatchObject({ action: 1 });
    expect(state.rows.size).toBe(0);
  });

  it('rejects wrong users, wrong session decisions, spoofed identity, and overload', async () => {
    const held = await heldRequest();
    state.authorized = false;
    await expect(bridge.handleResponse(response(held.id, 'approve'))).resolves.toBe(true);
    expect(bridge.pendingCount).toBe(1);

    const overloaded = await transform();
    expect(overloaded.action).toBe(2);
    expect(state.rows.size).toBe(1);

    state.authorized = true;
    const row = state.rows.get(held.id)!;
    row.payload = JSON.stringify({ runtimeIdentity: 'install/group/other' });
    await bridge.handleResponse(response(held.id, 'approve'));
    await expect(held.decision).resolves.toMatchObject({ action: 2 });

    const spoofed = await transform(
      {
        request: {
          method: 'POST',
          url: 'https://api.anthropic.com/v1/messages',
          host: 'api.anthropic.com',
          headers: { 'x-iron-workload-identity': { values: [identity.runtimeIdentity] } },
        },
      },
      new grpc.Metadata(),
    );
    expect(spoofed.action).toBe(2);
    expect(state.rows.size).toBe(0);
  });

  it('approves the inner HTTP request once and never creates a CONNECT approval', async () => {
    const connect = await transform({
      request: { method: 'CONNECT', url: '//api.anthropic.com:443', host: 'api.anthropic.com:443' },
    });
    expect(connect.action).toBe(1);
    expect(state.rows.size).toBe(0);

    const held = await heldRequest();
    expect(state.rows.size).toBe(1);
    await bridge.handleResponse(response(held.id, 'approve'));
    await expect(held.decision).resolves.toMatchObject({ action: 1 });
  });

  it('fails closed on denial, timeout, handler failure, and bridge restart', async () => {
    const denied = await heldRequest();
    await bridge.handleResponse(response(denied.id, 'reject'));
    await expect(denied.decision).resolves.toMatchObject({ action: 2 });

    const timedOut = await heldRequest();
    await expect(timedOut.decision).resolves.toMatchObject({ action: 2 });

    const failed = await heldRequest();
    state.failRead = true;
    await bridge.handleResponse(response(failed.id, 'approve'));
    await expect(failed.decision).resolves.toMatchObject({ action: 2 });
    state.failRead = false;

    const restarted = await heldRequest();
    await bridge.stop();
    await expect(restarted.decision).resolves.toMatchObject({ action: 2 });
  });
});
