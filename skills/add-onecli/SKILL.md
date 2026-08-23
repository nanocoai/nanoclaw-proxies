---
name: add-onecli
description: Install or refresh OneCLI as NanoClaw's gateway provider. Use when setup selects OneCLI, an existing OneCLI-backed install is migrated to the gateway seam, or the OneCLI runtime, approval cards, setup, and agent guidance must be restored from a pinned source.
---

# Add OneCLI gateway

This skill owns the full OneCLI integration. NanoClaw core supplies the generic gateway seam and existing skill engine.

## Install the provider payload

Copy the skill-owned runtime adapter, approval bridge, conformance tests, and agent guidance into their normal NanoClaw paths.

```nc:copy
payload/src/gateway-providers/onecli.ts -> src/gateway-providers/onecli.ts
payload/src/gateway-providers/onecli.test.ts -> src/gateway-providers/onecli.test.ts
payload/src/gateway-providers/onecli-uninstall.ts -> src/gateway-providers/onecli-uninstall.ts
payload/src/gateway-providers/onecli-uninstall.test.ts -> src/gateway-providers/onecli-uninstall.test.ts
payload/src/modules/approvals/onecli-approvals.ts -> src/modules/approvals/onecli-approvals.ts
payload/src/modules/approvals/expired-card-instance.test.ts -> src/modules/approvals/expired-card-instance.test.ts
payload/container/skills/onecli-gateway/SKILL.md -> container/skills/onecli-gateway/SKILL.md
payload/container/skills/onecli-gateway/instructions.md -> container/skills/onecli-gateway/instructions.md
```

## Register once

The provider file makes the only product registration call. The generic seam connects its lifecycle, session lease, network access, approval response handler, and agent skill.

```nc:append to:src/gateway-providers/installed.ts
import './onecli.js';
```

## Install the pinned SDK

```nc:dep manager:pnpm
@onecli-sh/sdk@2.2.1
```

## Configure the gateway

The setup script safely reuses a healthy existing installation, installs the pinned local gateway when absent, or uses `NANOCLAW_ONECLI_API_HOST` and `NANOCLAW_ONECLI_API_TOKEN` for a remote gateway.

```nc:run effect:external
pnpm exec tsx .claude/skills/add-onecli/scripts/setup.ts
```

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/onecli.test.ts src/gateway-providers/onecli-uninstall.test.ts src/modules/approvals/expired-card-instance.test.ts src/gateway-providers/gateway-provider-registry.test.ts
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=onecli` only after every directive above succeeds. Claude authentication is then completed through `scripts/auth.ts`; credentials never enter an agent container.

During an atomic NanoClaw upgrade, `scripts/detect.ts` identifies an older implicit OneCLI installation so the generic updater can preserve that choice before the service restarts.
