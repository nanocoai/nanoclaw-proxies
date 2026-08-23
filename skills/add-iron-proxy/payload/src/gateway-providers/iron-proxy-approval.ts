import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type { QuestionRender } from '../channels/question-render-registry.js';
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApproval,
  getPendingApprovalsByAction,
  getSession,
  transitionPendingApprovalStatus,
} from '../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';
import { pickApprovalDelivery, pickApprover } from '../modules/approvals/primitive.js';
import { isAuthorizedApprovalClick } from '../modules/approvals/response-handler.js';
import type { ResponsePayload } from '../response-registry.js';
import type { PendingApproval } from '../types.js';

export const IRON_PROXY_APPROVAL_ACTION = 'iron_proxy_credential';
export const IRON_PROXY_IDENTITY_METADATA = 'x-iron-workload-identity';

const CONTINUE = 1;
const REJECT = 2;
const OPTIONS = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' as const },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' as const },
];

interface TransformRequest {
  method?: string;
  url?: string;
  host?: string;
}

interface TransformRequestMessage {
  request?: TransformRequest;
}

interface TransformReply {
  action: number;
  response?: { statusCode: number; body: Buffer };
}

export interface IronApprovalIdentity {
  runtimeIdentity: string;
  sessionId: string;
  agentGroupId: string;
  groupName: string;
}

export interface IronApprovalBridgeSettings {
  socketPath: string;
  timeoutMs: number;
  maxPending: number;
  protoPath?: string;
}

interface PendingState {
  identity: string;
  timer: NodeJS.Timeout;
  resolve: (approved: boolean) => void;
}

type IdentityResolver = (runtimeIdentity: string) => IronApprovalIdentity | undefined;

function rejection(text = 'Request denied by approval policy'): TransformReply {
  return { action: REJECT, response: { statusCode: 403, body: Buffer.from(text) } };
}

function metadataIdentity(metadata: grpc.Metadata): string | undefined {
  const values = metadata.get(IRON_PROXY_IDENTITY_METADATA);
  return values.length === 1 && typeof values[0] === 'string' && values[0].length <= 512 ? values[0] : undefined;
}

function safeRequest(
  request: TransformRequest | undefined,
): { method: string; host: string; path: string } | undefined {
  const method = request?.method?.toUpperCase() ?? '';
  if (!/^[A-Z]{1,16}$/.test(method)) return undefined;
  const host = (request?.host ?? '').slice(0, 253);
  if (!host || /[\0\r\n]/.test(host)) return undefined;
  let requestPath = '/';
  try {
    requestPath = new URL(request?.url || '/', `https://${host}`).pathname;
  } catch {
    return undefined;
  }
  return { method, host, path: requestPath.slice(0, 240) || '/' };
}

function serviceDefinition(protoPath: string): grpc.ServiceDefinition {
  const definition = protoLoader.loadSync(protoPath, {
    defaults: true,
    enums: Number,
    longs: String,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    transform: { v1: { TransformService: { service: grpc.ServiceDefinition } } };
  };
  return loaded.transform.v1.TransformService.service;
}

export class IronProxyApprovalBridge {
  readonly #pending = new Map<string, PendingState>();
  #adapter: ChannelDeliveryAdapter | null = null;
  #server: grpc.Server | null = null;

  constructor(
    readonly settings: IronApprovalBridgeSettings,
    private readonly resolveIdentity: IdentityResolver,
  ) {}

  get running(): boolean {
    return this.#server !== null;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  async start(deliveryAdapter: ChannelDeliveryAdapter): Promise<void> {
    if (this.#server) return;
    this.#adapter = deliveryAdapter;
    await this.#sweepStaleApprovals();
    fs.mkdirSync(path.dirname(this.settings.socketPath), { recursive: true, mode: 0o700 });
    fs.rmSync(this.settings.socketPath, { force: true });

    const server = new grpc.Server({
      'grpc.max_receive_message_length': 1024 * 1024,
      'grpc.max_send_message_length': 64 * 1024,
    });
    const transformRequest: grpc.handleUnaryCall<TransformRequestMessage, TransformReply> = (call, callback) => {
      void this.#transformRequest(call).then(
        (reply) => callback(null, reply),
        (err) => {
          log.error('Iron Proxy approval transform failed closed', { err });
          callback(null, rejection('Approval bridge failed'));
        },
      );
    };
    const transformResponse: grpc.handleUnaryCall<TransformRequestMessage, TransformReply> = (call, callback) => {
      const identity = metadataIdentity(call.metadata);
      callback(null, identity && this.resolveIdentity(identity) ? { action: CONTINUE } : rejection());
    };
    server.addService(
      serviceDefinition(
        this.settings.protoPath ?? path.join(process.cwd(), 'src', 'gateway-providers', 'iron-proxy-transform.proto'),
      ),
      {
        TransformRequest: transformRequest,
        transformRequest,
        TransformResponse: transformResponse,
        transformResponse,
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.bindAsync(`unix:${this.settings.socketPath}`, grpc.ServerCredentials.createInsecure(), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    fs.chmodSync(this.settings.socketPath, 0o600);
    this.#server = server;
    log.info('Iron Proxy approval bridge started', { socketPath: this.settings.socketPath });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    for (const [approvalId, state] of [...this.#pending]) {
      await this.#forceDeny(approvalId, state, 'host restarted');
    }
    if (server) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          server.forceShutdown();
          resolve();
        }, 5_000);
        server.tryShutdown(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.#adapter = null;
    fs.rmSync(this.settings.socketPath, { force: true });
  }

  async handleResponse(payload: ResponsePayload): Promise<boolean> {
    try {
      const approval = await getPendingApproval(payload.questionId);
      if (!approval || approval.action !== IRON_PROXY_APPROVAL_ACTION) return false;
      if (!(await isAuthorizedApprovalClick(approval, payload))) return true;
      const state = this.#pending.get(approval.approval_id);
      const stored = JSON.parse(approval.payload) as { runtimeIdentity?: string };
      if (!state || stored.runtimeIdentity !== state.identity || !this.resolveIdentity(state.identity)) {
        if (state) await this.#forceDeny(approval.approval_id, state, 'identity mismatch');
        else await deletePendingApproval(approval.approval_id);
        return true;
      }
      await this.#settle(approval, state, payload.value === 'approve');
      return true;
    } catch (err) {
      const state = this.#pending.get(payload.questionId);
      if (state) await this.#forceDeny(payload.questionId, state, 'handler failure');
      log.error('Iron Proxy approval response failed closed', { approvalId: payload.questionId, err });
      return true;
    }
  }

  async renderQuestion(questionId: string): Promise<QuestionRender | undefined> {
    const approval = await getPendingApproval(questionId);
    if (!approval || approval.action !== IRON_PROXY_APPROVAL_ACTION || !approval.title) return undefined;
    return {
      title: approval.title,
      question: approval.question || undefined,
      options: JSON.parse(approval.options_json) as QuestionRender['options'],
    };
  }

  async cancelIdentity(runtimeIdentity: string): Promise<void> {
    for (const [approvalId, state] of [...this.#pending]) {
      if (state.identity === runtimeIdentity) await this.#forceDeny(approvalId, state, 'session ended');
    }
  }

  async #transformRequest(
    call: grpc.ServerUnaryCall<TransformRequestMessage, TransformReply>,
  ): Promise<TransformReply> {
    if (!this.#server || !this.#adapter) return rejection('Approval bridge unavailable');
    const runtimeIdentity = metadataIdentity(call.metadata);
    if (!runtimeIdentity) return rejection('Unknown workload identity');
    const identity = this.resolveIdentity(runtimeIdentity);
    if (!identity) return rejection('Unknown workload identity');

    const request = safeRequest(call.request.request);
    if (!request) return rejection('Invalid request metadata');
    // Iron evaluates a synthetic CONNECT before MITM. The inner HTTP request is
    // the only approval point, preventing two cards for one upstream request.
    if (request.method === 'CONNECT') return { action: CONTINUE };
    if (this.#pending.size >= this.settings.maxPending) return rejection('Approval queue is full');

    const session = await getSession(identity.sessionId);
    if (!session || session.agent_group_id !== identity.agentGroupId || session.status !== 'active') {
      return rejection('Session is no longer active');
    }
    const approvers = await pickApprover(identity.agentGroupId);
    const target = await pickApprovalDelivery(approvers, '');
    if (!target) return rejection('No eligible approver is reachable');

    const approvalId = `ip-${randomBytes(4).toString('hex')}`;
    const title = 'Network credentials request';
    const question = `*Agent:* ${identity.groupName.slice(0, 120)}\n*Request:* ${request.method} ${request.host}${request.path}`;
    let platformMessageId: string | undefined;
    try {
      platformMessageId = await this.#adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({ type: 'ask_question', questionId: approvalId, title, question, options: OPTIONS }),
        undefined,
        target.messagingGroup.instance,
      );
    } catch (err) {
      log.error('Failed to deliver Iron Proxy approval card', { approvalId, err });
      return rejection('Approval card delivery failed');
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.settings.timeoutMs);
    const created = await createPendingApproval({
      approval_id: approvalId,
      session_id: identity.sessionId,
      request_id: approvalId,
      action: IRON_PROXY_APPROVAL_ACTION,
      payload: JSON.stringify({ runtimeIdentity, method: request.method, host: request.host, path: request.path }),
      created_at: createdAt.toISOString(),
      agent_group_id: identity.agentGroupId,
      channel_type: target.messagingGroup.channel_type,
      platform_id: target.messagingGroup.platform_id,
      instance: target.messagingGroup.instance ?? null,
      platform_message_id: platformMessageId ?? null,
      expires_at: expiresAt.toISOString(),
      status: 'pending',
      approver_user_id: target.userId,
      title,
      question,
      options_json: JSON.stringify(OPTIONS),
    });
    if (!created) return rejection('Approval id collision');

    const approved = await new Promise<boolean>((resolve) => {
      const state: PendingState = {
        identity: runtimeIdentity,
        resolve,
        timer: setTimeout(() => {
          const approval = getPendingApproval(approvalId);
          void approval
            .then(async (row) => {
              if (row) await this.#settle(row, state, false, 'expired');
              else await this.#forceDeny(approvalId, state, 'timeout');
            })
            .catch(() => this.#forceDeny(approvalId, state, 'timeout'));
        }, this.settings.timeoutMs),
      };
      this.#pending.set(approvalId, state);
      call.on('cancelled', () => void this.#forceDeny(approvalId, state, 'request cancelled'));
    });
    return approved ? { action: CONTINUE } : rejection();
  }

  async #settle(
    approval: PendingApproval,
    state: PendingState,
    approved: boolean,
    deniedStatus: 'rejected' | 'expired' = 'rejected',
  ): Promise<boolean> {
    if (this.#pending.get(approval.approval_id) !== state) return false;
    const claimed = await transitionPendingApprovalStatus(
      approval.approval_id,
      'pending',
      approved ? 'approved' : deniedStatus,
    );
    if (!claimed) return false;
    this.#pending.delete(approval.approval_id);
    clearTimeout(state.timer);
    if (!approved && deniedStatus === 'expired') await this.#editExpiredCard(approval, 'no response');
    await deletePendingApproval(approval.approval_id);
    state.resolve(approved);
    return true;
  }

  async #forceDeny(approvalId: string, state: PendingState, reason: string): Promise<void> {
    if (this.#pending.get(approvalId) !== state) return;
    this.#pending.delete(approvalId);
    clearTimeout(state.timer);
    try {
      const approval = await getPendingApproval(approvalId);
      if (approval) {
        await this.#editExpiredCard(approval, reason === 'host restarted' ? 'host restarted' : 'request cancelled');
      }
    } catch (err) {
      log.error('Failed to read denied Iron Proxy approval', { approvalId, err });
    } finally {
      try {
        await transitionPendingApprovalStatus(approvalId, 'pending', 'expired');
        await deletePendingApproval(approvalId);
      } catch (err) {
        log.error('Failed to delete denied Iron Proxy approval', { approvalId, err });
      }
      state.resolve(false);
    }
  }

  async #editExpiredCard(
    row: PendingApproval,
    reason: 'no response' | 'host restarted' | 'request cancelled',
  ): Promise<void> {
    if (!this.#adapter || !row.platform_message_id || !row.channel_type || !row.platform_id) return;
    const resolution =
      reason === 'no response'
        ? '⏱️ Timed out — no response'
        : reason === 'host restarted'
          ? '⏱️ Timed out — host restarted before resolution'
          : '⛔ Cancelled before resolution';
    try {
      await this.#adapter.deliver(
        row.channel_type,
        row.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          operation: 'edit',
          messageId: row.platform_message_id,
          text: [row.title, row.question, resolution].filter(Boolean).join('\n\n'),
          terminalCard: { title: row.title, question: row.question, resolution },
        }),
        undefined,
        row.instance ?? row.channel_type,
      );
    } catch (err) {
      log.error('Failed to edit expired Iron Proxy approval card', { approvalId: row.approval_id, err });
    }
  }

  async #sweepStaleApprovals(): Promise<void> {
    for (const row of await getPendingApprovalsByAction(IRON_PROXY_APPROVAL_ACTION)) {
      await this.#editExpiredCard(row, 'host restarted');
      await deletePendingApproval(row.approval_id);
    }
  }
}
