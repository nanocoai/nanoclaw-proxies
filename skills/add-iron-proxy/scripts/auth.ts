import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as p from "@clack/prompts";

import { configureCredential, statePaths } from "./setup.js";

type Method = "subscription" | "oauth" | "api" | "skip";

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Error("Authentication cancelled");
  return value as T;
}

function existingCredential(): boolean {
  const file = statePaths().secretFile;
  if (!fs.existsSync(file)) return false;
  const value = fs.readFileSync(file, "utf8");
  return !!value && value !== "not-configured";
}

export function customEndpoint(env: NodeJS.ProcessEnv = process.env): {
  secret: string;
  authEnv: string;
  modelHost: string;
  baseUrl: string;
} | null {
  const baseUrl = env.NANOCLAW_ANTHROPIC_BASE_URL?.trim();
  const secret = env.NANOCLAW_ANTHROPIC_AUTH_TOKEN?.trim();
  if (!baseUrl || !secret) return null;
  const url = new URL(baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const local = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Custom Claude endpoint must use HTTPS unless it is local");
  }
  if (local) url.hostname = "host.docker.internal";
  return {
    secret,
    authEnv: "ANTHROPIC_AUTH_TOKEN",
    modelHost: url.hostname,
    baseUrl: url.toString().replace(/\/$/, ""),
  };
}

function capturedSubscriptionToken(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nanoclaw-iron-proxy-auth-"),
  );
  const output = path.join(dir, "token");
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "capture-claude-token.sh",
  );
  try {
    const result = spawnSync("bash", [script, output], { stdio: "inherit" });
    if (result.status !== 0 || !fs.existsSync(output))
      throw new Error("Claude subscription sign-in failed");
    const token = fs.readFileSync(output, "utf8").trim();
    if (!token.startsWith("sk-ant-oat"))
      throw new Error("Claude subscription sign-in returned an invalid token");
    return token;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function run(): Promise<void> {
  const custom = customEndpoint();
  if (custom) {
    await configureCredential(custom);
    p.log.success("Claude endpoint connected through Iron Proxy.");
    return;
  }
  const suppliedApiKey = (
    process.env.NANOCLAW_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
  )?.trim();
  if (suppliedApiKey) {
    await configureCredential({
      secret: suppliedApiKey,
      authEnv: "ANTHROPIC_API_KEY",
      modelHost: "api.anthropic.com",
    });
    p.log.success("Claude API connected through Iron Proxy.");
    return;
  }
  if (existingCredential()) {
    p.log.success("Claude account is already connected through Iron Proxy.");
    return;
  }

  const method = answer<Method>(
    await p.select({
      message: "How would you like to connect to Claude?",
      options: [
        {
          value: "subscription",
          label: "Claude subscription",
          hint: "recommended for Pro or Max",
        },
        { value: "oauth", label: "Paste an OAuth token" },
        { value: "api", label: "Paste an Anthropic API key" },
        { value: "skip", label: "Skip for now" },
      ],
    }),
  );
  if (method === "skip") {
    p.log.warn(
      "Claude is not connected. Run setup again before starting an agent.",
    );
    return;
  }
  const secret =
    method === "subscription"
      ? capturedSubscriptionToken()
      : answer<string>(
          await p.password({
            message:
              method === "oauth"
                ? "Paste your OAuth token"
                : "Paste your API key",
            clearOnError: true,
            validate: (raw) => {
              const value = (raw ?? "").replace(/\s+/g, "");
              const prefix = method === "oauth" ? "sk-ant-oat" : "sk-ant-api";
              return value.startsWith(prefix)
                ? undefined
                : `Must start with ${prefix}`;
            },
          }),
        ).replace(/\s+/g, "");
  await configureCredential({
    secret,
    authEnv: method === "api" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN",
    modelHost: "api.anthropic.com",
  });
  p.log.success("Claude account connected through Iron Proxy.");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
