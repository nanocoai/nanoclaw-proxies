import type {
  GatewayCommandRunner,
  GatewayExternalResource,
  GatewayExternalResourceScan,
  GatewayUninstallSupport,
} from "./gateway-provider-registry.js";

function listAgents(run: GatewayCommandRunner): {
  available: boolean;
  resources: GatewayExternalResource[];
} {
  let result: ReturnType<GatewayCommandRunner>;
  try {
    result = run("onecli", ["agents", "list"]);
  } catch {
    return { available: false, resources: [] };
  }
  if (result.status !== 0) return { available: false, resources: [] };
  let data: unknown;
  try {
    data = (JSON.parse(result.stdout) as { data?: unknown }).data;
  } catch {
    return { available: false, resources: [] };
  }
  if (!Array.isArray(data)) return { available: false, resources: [] };
  const resources: GatewayExternalResource[] = [];
  for (const value of data) {
    if (!value || typeof value !== "object") continue;
    const agent = value as Record<string, unknown>;
    if (agent.isDefault === true) continue;
    const id = typeof agent.id === "string" ? agent.id : "";
    const identifier =
      typeof agent.identifier === "string" ? agent.identifier : "";
    if (!id || !identifier || identifier === "default") continue;
    resources.push({
      id,
      identifier,
      label: typeof agent.name === "string" ? agent.name : identifier,
    });
  }
  return { available: true, resources };
}

export const onecliUninstall: GatewayUninstallSupport = {
  sharedResourcesNote:
    "OneCLI application, vault, and credentials are shared and remain installed.",
  scanExternalResources(
    agentGroupIds,
    idsKnown,
    run,
  ): GatewayExternalResourceScan {
    const listed = listAgents(run);
    const owned: GatewayExternalResource[] = [];
    const unknown: GatewayExternalResource[] = [];
    for (const resource of listed.resources) {
      if (idsKnown && agentGroupIds.has(resource.identifier))
        owned.push(resource);
      else if (resource.identifier.startsWith("ag-")) unknown.push(resource);
    }
    return { available: listed.available, owned, unknown };
  },
  removeExternalResource(resource, run) {
    return run("onecli", ["agents", "delete", "--id", resource.id]);
  },
  manualRemoval(resource) {
    return `onecli agents delete --id ${resource.id}`;
  },
};
