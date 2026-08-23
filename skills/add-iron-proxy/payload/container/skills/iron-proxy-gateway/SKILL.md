---
name: iron-proxy-gateway
description: Explain NanoClaw's Iron Proxy egress boundary and recover from blocked outbound requests without requesting or exposing raw credentials.
compatibility: Requires HTTP_PROXY, HTTPS_PROXY, and the Iron Proxy CA injected by NanoClaw.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Iron Proxy gateway

Your outbound HTTP and HTTPS requests pass through Iron Proxy. The selected model credential is replaced at the proxy boundary; you receive only a useless placeholder.

## Policy failures

A `403` from the proxy means the destination is not allowed. Respect the block and do not retry through another route. Tell the user which hostname was blocked.

An operator may allow that hostname on the NanoClaw host with:

```bash
pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --allow-host <hostname-or-*.domain>
```

Do not run this host command from the agent container.

## Rules

- Never ask for, print, or store a raw API key or OAuth token.
- Never bypass the configured proxy or its CA validation.
- Never claim a blocked destination is connected.
- Treat proxy errors as policy or operator-configuration errors, not as permission to weaken TLS.
