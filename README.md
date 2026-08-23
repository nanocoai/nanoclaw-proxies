# NanoClaw gateway providers

Installable gateway-provider skills for [NanoClaw](https://github.com/nanoclaw/nanoclaw).

Each provider owns its runtime adapter, setup, tests, cleanup guidance, and agent instructions. NanoClaw integrates it through one `registerGatewayProvider(...)` call and the existing skill engine.

## Providers

| Skill | Purpose |
| --- | --- |
| `add-onecli` | OneCLI credential gateway and approval cards |

Consumers must pin a commit SHA. Branches, tags, and `HEAD` are not valid install references.
