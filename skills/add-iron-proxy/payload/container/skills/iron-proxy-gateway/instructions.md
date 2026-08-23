# Credentials and egress

HTTP and HTTPS traffic uses the selected session's Iron Proxy. Policy-selected credential use waits for human approval, then the credential is inserted only at the proxy boundary; local values are placeholders.

If a request returns `403`, report the blocked hostname and respect the policy; denial and timeout are final. The operator can explicitly allow a new hostname from the NanoClaw host with `pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --allow-host <hostname-or-*.domain>`. Never ask the user to paste a secret into chat and never disable TLS verification.
