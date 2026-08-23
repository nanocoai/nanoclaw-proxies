import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayApprovalDecision, GatewayApprovalRequest } from './gateway-provider-registry.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
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

interface HeldDecision {
  request: GatewayApprovalRequest;
  resolve: (decision: GatewayApprovalDecision) => void;
}

const identity: IronApprovalIdentity = {
  runtimeIdentity: 'install/group/session',
  sessionId: 'session',
  agentGroupId: 'group',
  groupName: 'Group One',
};
const held = new Map<string, HeldDecision>();
let identityActive = true;
let failDecider = false;
let root: string;
let bridge: IronProxyApprovalBridge;
let client: TransformClient;
let controller: AbortController;
let subscription: Promise<void>;

function metadata(runtimeIdentity = identity.runtimeIdentity): grpc.Metadata {
  const value = new grpc.Metadata();
  value.set(IRON_PROXY_IDENTITY_METADATA, runtimeIdentity);
  return value;
}

function transformCall(
  request: Record<string, unknown> = {
    request: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages?private=query',
      host: 'api.anthropic.com',
      headers: { Authorization: { values: ['Bearer real-secret'] } },
      body: Buffer.from('private body'),
    },
  },
  requestMetadata = metadata(),
): { call: grpc.ClientUnaryCall; result: Promise<{ action: number }> } {
  let call!: grpc.ClientUnaryCall;
  const result = new Promise<{ action: number }>((resolve, reject) => {
    call = client.transformRequest(request, requestMetadata, (error, response) =>
      error ? reject(error) : resolve(response),
    );
  });
  return { call, result };
}

async function transform(
  request?: Record<string, unknown>,
  requestMetadata?: grpc.Metadata,
): Promise<{ action: number }> {
  return transformCall(request, requestMetadata).result;
}

async function heldRequest(): Promise<{
  id: string;
  request: GatewayApprovalRequest;
  result: Promise<{ action: number }>;
}> {
  const { result } = transformCall();
  await vi.waitFor(() => expect(held.size).toBe(1));
  const [id, decision] = [...held.entries()][0];
  return { id, request: decision.request, result };
}

beforeEach(async () => {
  held.clear();
  identityActive = true;
  failDecider = false;
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-approval-'));
  const protoPath = path.join(process.cwd(), 'src', 'gateway-providers', 'iron-proxy-transform.proto');
  bridge = new IronProxyApprovalBridge(
    { socketPath: path.join(root, 'approval.sock'), timeoutMs: 100, maxPending: 1, protoPath },
    (runtimeIdentity) => (identityActive && runtimeIdentity === identity.runtimeIdentity ? identity : undefined),
  );
  controller = new AbortController();
  subscription = bridge.subscribe(async (request) => {
    if (failDecider) throw new Error('core unavailable');
    return new Promise<GatewayApprovalDecision>((resolve) => held.set(request.id, { request, resolve }));
  }, controller.signal);
  await bridge.ready();
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
  controller.abort();
  await subscription;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Iron Proxy approval transport', () => {
  it('holds a privacy-safe normalized request and forwards exactly once after approval', async () => {
    const request = await heldRequest();
    let settled = false;
    void request.result.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(request.request).toMatchObject({
      agentGroupId: 'group',
      sessionId: 'session',
      runtimeIdentity: identity.runtimeIdentity,
      title: 'Network credentials request',
      audit: { method: 'POST', host: 'api.anthropic.com', path: '/v1/messages' },
    });
    const visible = JSON.stringify(request.request);
    expect(visible).not.toContain('private=query');
    expect(visible).not.toContain('real-secret');
    expect(visible).not.toContain('private body');

    held.get(request.id)!.resolve('approve');
    await expect(request.result).resolves.toMatchObject({ action: 1 });
    expect(bridge.pendingCount).toBe(0);
  });

  it('rejects stale identity, spoofed identity, and overload', async () => {
    const first = await heldRequest();
    const overloaded = await transform();
    expect(overloaded.action).toBe(2);

    identityActive = false;
    held.get(first.id)!.resolve('approve');
    await expect(first.result).resolves.toMatchObject({ action: 2 });

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
  });

  it('continues synthetic CONNECT without creating a duplicate approval', async () => {
    const connect = await transform({
      request: { method: 'CONNECT', url: '//api.anthropic.com:443', host: 'api.anthropic.com:443' },
    });
    expect(connect.action).toBe(1);
    expect(held.size).toBe(0);

    const inner = await heldRequest();
    held.get(inner.id)!.resolve('approve');
    await expect(inner.result).resolves.toMatchObject({ action: 1 });
  });

  it('fails closed on denial, timeout, callback failure, cancellation, and restart', async () => {
    const denied = await heldRequest();
    held.get(denied.id)!.resolve('deny');
    await expect(denied.result).resolves.toMatchObject({ action: 2 });

    const timedOut = await heldRequest();
    await expect(timedOut.result).resolves.toMatchObject({ action: 2 });
    held.clear();

    failDecider = true;
    await expect(transform()).resolves.toMatchObject({ action: 2 });
    failDecider = false;

    const cancelled = transformCall();
    await vi.waitFor(() => expect(bridge.pendingCount).toBe(1));
    cancelled.call.cancel();
    await expect(cancelled.result).rejects.toMatchObject({ code: grpc.status.CANCELLED });
    held.clear();

    const restarted = await heldRequest();
    controller.abort();
    await expect(restarted.result).resolves.toMatchObject({ action: 2 });
    await subscription;
  });
});
