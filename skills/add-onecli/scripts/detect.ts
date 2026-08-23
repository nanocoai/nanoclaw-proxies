import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function envHasGateway(root: string): boolean {
  try {
    return /^ONECLI_URL=\S+/m.test(
      fs.readFileSync(path.join(root, ".env"), "utf8"),
    );
  } catch {
    return false;
  }
}

function cliHasGateway(): boolean {
  try {
    execFileSync("onecli", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

console.log(
  envHasGateway(process.cwd()) || cliHasGateway() ? "installed" : "absent",
);
