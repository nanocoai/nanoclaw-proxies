---
name: add-iron-proxy
description: Install or refresh Iron Proxy as NanoClaw's central gateway provider. Use when setup selects Iron Proxy or its pinned runtime, policy, credential custody, and agent guidance must be restored.
---

# Add Iron Proxy gateway

This skill owns the full Iron Proxy integration. NanoClaw core supplies the generic gateway seam and existing skill engine.

## Install the provider payload

```nc:copy
payload/src/gateway-providers/iron-proxy.ts -> src/gateway-providers/iron-proxy.ts
payload/src/gateway-providers/iron-proxy.test.ts -> src/gateway-providers/iron-proxy.test.ts
payload/container/skills/iron-proxy-gateway/SKILL.md -> container/skills/iron-proxy-gateway/SKILL.md
payload/container/skills/iron-proxy-gateway/instructions.md -> container/skills/iron-proxy-gateway/instructions.md
```

## Register once

The provider file makes the only product registration call. The generic seam connects readiness, lifecycle, session contributions, central-network access, and agent guidance.

```nc:append to:src/gateway-providers/installed.ts
import './iron-proxy.js';
```

## Configure the pinned central proxy

Setup creates owner-only credential custody, an install-scoped CA, and a starter policy that allows only the selected model API. The proxy image is pinned by digest.

```nc:run effect:external
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts
```

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/iron-proxy.test.ts src/gateway-providers/gateway-provider-registry.test.ts
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=iron-proxy` only after every directive succeeds. Agent-provider authentication then stores the real model credential only in the proxy's owner-only env file; sessions receive a placeholder and read-only CA.

To allow another destination explicitly, the operator runs:

```bash
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --allow-host <hostname-or-*.domain>
```
