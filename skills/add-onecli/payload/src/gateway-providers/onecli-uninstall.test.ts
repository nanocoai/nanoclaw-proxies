import { describe, expect, it } from "vitest";

import { onecliUninstall } from "./onecli-uninstall.js";

describe("OneCLI uninstall ownership", () => {
  it("deletes only exact agent-group matches by the provider resource id", () => {
    const run = () => ({
      status: 0,
      stdout: JSON.stringify({
        data: [
          { id: "owned-id", identifier: "ag-owned", name: "Owned" },
          { id: "other-id", identifier: "ag-other", name: "Other" },
          {
            id: "default-id",
            identifier: "default",
            name: "Default",
            isDefault: true,
          },
        ],
      }),
    });
    const scan = onecliUninstall.scanExternalResources(
      new Set(["ag-owned"]),
      true,
      run,
    );
    expect(scan.owned.map((resource) => resource.id)).toEqual(["owned-id"]);
    expect(scan.unknown.map((resource) => resource.id)).toEqual(["other-id"]);

    const calls: string[][] = [];
    onecliUninstall.removeExternalResource(scan.owned[0], (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: "" };
    });
    expect(calls).toEqual([["onecli", "agents", "delete", "--id", "owned-id"]]);
  });
});
