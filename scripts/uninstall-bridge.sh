#!/bin/zsh
set -euo pipefail

installed_binary="$HOME/Library/Application Support/CodexPulse/bin/codex-pulse-bridge"

if [[ -x "$installed_binary" ]]; then
  "$installed_binary" service-uninstall --yes || true
  "$installed_binary" notify-uninstall --yes || true
  "$installed_binary" local-reset --yes
  echo "Bridge state and binary moved to Trash together. Revoke the host from the phone if it is still listed."
else
  echo "CodexPulse Bridge binary is not installed."
fi
