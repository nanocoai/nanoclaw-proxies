#!/usr/bin/env bash
set -euo pipefail

if command -v claude >/dev/null 2>&1; then
  exit 0
fi
command -v curl >/dev/null 2>&1 || { echo "curl is required to install Claude Code." >&2; exit 1; }
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
command -v claude >/dev/null 2>&1 || { echo "Claude Code was not found after installation." >&2; exit 1; }
