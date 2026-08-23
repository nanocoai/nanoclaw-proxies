---
name: add-iron-proxy
description: Install or refresh Iron Proxy as NanoClaw's session-scoped gateway provider. Use when setup selects Iron Proxy or its pinned runtime, approval transport, policy, credential custody, and agent guidance must be restored.
---

# Add Iron Proxy gateway

This skill owns the full Iron Proxy integration. NanoClaw core supplies the generic gateway seam and existing skill engine.

## Install the provider payload

```nc:copy
payload/src/gateway-providers/iron-proxy.ts -> src/gateway-providers/iron-proxy.ts
payload/src/gateway-providers/iron-proxy.test.ts -> src/gateway-providers/iron-proxy.test.ts
payload/src/gateway-providers/iron-proxy-approval.ts -> src/gateway-providers/iron-proxy-approval.ts
payload/src/gateway-providers/iron-proxy-approval.test.ts -> src/gateway-providers/iron-proxy-approval.test.ts
payload/src/gateway-providers/iron-proxy-transform.proto -> src/gateway-providers/iron-proxy-transform.proto
payload/container/skills/iron-proxy-gateway/SKILL.md -> container/skills/iron-proxy-gateway/SKILL.md
payload/container/skills/iron-proxy-gateway/instructions.md -> container/skills/iron-proxy-gateway/instructions.md
```

## Register once

The provider file makes the only product registration call. It declares idempotent sessions, typed runtime contributions, owned-resource cleanup, normalized approvals, network access, and agent guidance. NanoClaw core owns approval persistence, cards, clicks, authorization, and timeouts.

```nc:append to:src/gateway-providers/installed.ts
import './iron-proxy.js';
```

## Install the bridge dependencies

```nc:dep manager:pnpm
@grpc/grpc-js@1.14.4
@grpc/proto-loader@0.8.1
```

## Configure the pinned proxy

Setup creates owner-only credential custody, an install-scoped CA, and a starter policy. Each live session gets one pinned Iron Proxy container; NanoClaw's approval service is reached through a private Unix socket, not another proxy or an exposed host port.

```nc:run effect:external
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts
```

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/iron-proxy.test.ts src/gateway-providers/iron-proxy-approval.test.ts src/gateway-providers/gateway-provider-registry.test.ts src/gateway-approval-coordinator.test.ts
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=iron-proxy` only after every directive succeeds. Agent-provider authentication stores the real model credential only in an owner-only file mounted into the selected session proxy. Sessions receive a placeholder and public CA.

The transform order is fixed: allowlist → synchronous human approval → secret injection → upstream. Approval and secret matching are rendered from one rule object. CONNECT is checked by the allowlist but approved only on its inner HTTP request. Iron Proxy rejects non-HTTP tunnel payloads before dialing upstream.

To allow another destination explicitly, the operator runs:

```bash
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --allow-host <hostname-or-*.domain>
```
