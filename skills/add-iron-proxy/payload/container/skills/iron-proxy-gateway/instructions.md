# Credentials and egress

HTTP and HTTPS traffic uses Iron Proxy. The model credential is inserted only at the proxy boundary; local credential values are placeholders.

If a request returns `403`, report the blocked hostname and respect the policy. The operator can explicitly allow it from the NanoClaw host with `pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --allow-host <hostname-or-*.domain>`. Never ask the user to paste a secret into chat and never disable TLS verification.
