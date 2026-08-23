import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("../env.js", () => ({ readEnvFile: () => ({}) }));

import {
  IronProxyProvider,
  ironProxyContribution,
  readIronProxySettings,
} from "./iron-proxy.js";

const settings = {
  port: 18080,
  containerName: "nanoclaw-iron-proxy-test",
  caCert: "/safe/iron-proxy-ca.crt",
  authEnv: "ANTHROPIC_API_KEY",
};

describe("IronProxyProvider", () => {
  it("contributes only a proxy placeholder and read-only CA", () => {
    expect(ironProxyContribution(settings, "g1")).toMatchObject({
      env: {
        HTTPS_PROXY: "http://host.docker.internal:18080",
        ANTHROPIC_API_KEY: "gateway-managed",
        NODE_EXTRA_CA_CERTS: "/run/nanoclaw-gateway/iron-proxy-ca.crt",
      },
      mounts: [
        {
          class: "allowlisted-extra",
          hostPath: "/safe/iron-proxy-ca.crt",
          containerPath: "/run/nanoclaw-gateway/iron-proxy-ca.crt",
          mode: "ro",
          groupScope: "g1",
        },
      ],
    });
  });

  it("refuses invalid setup state", () => {
    expect(() =>
      readIronProxySettings({ NANOCLAW_IRON_PROXY_PORT: "80" }, "/tmp/project"),
    ).toThrow(/valid unprivileged port/);
    expect(() =>
      readIronProxySettings(
        {
          NANOCLAW_IRON_PROXY_PORT: "18080",
          NANOCLAW_IRON_PROXY_AUTH_ENV: "ARBITRARY_SECRET",
        },
        "/tmp/project",
      ),
    ).toThrow(/unsupported/);
  });

  it("stops registered sessions when the central proxy disappears", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "iron-proxy-provider-"));
    const caCert = path.join(root, "ca.crt");
    fs.writeFileSync(caCert, "test ca");
    let running = true;
    let poll: (() => void) | undefined;
    const provider = new IronProxyProvider({
      settings: () => ({ ...settings, caCert }),
      isRunning: () => running,
      setInterval: (callback) => {
        poll = callback;
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval: vi.fn(),
    });
    provider.startHost();
    const session = await provider.prepareSession({
      key: { installSlug: "i1", agentGroupId: "g1", sessionId: "s1" },
      groupName: "Group",
      capabilities: {
        isolationTiers: ["container"],
        admissionEnforced: false,
        networkPolicy: "topology",
        encryptedVolumes: false,
        unrealized: [],
        sharedNetworkNamespace: false,
        auxiliaryContainers: false,
        imageBuild: true,
      },
    });
    const unavailable = vi.fn();
    session.onUnavailable?.(unavailable);
    running = false;
    poll?.();
    expect(unavailable).toHaveBeenCalledWith("Iron Proxy became unavailable");
    provider.stopHost();
  });
});
