#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_root=${script_dir:h}
bridge_root="$project_root/apps/macos-bridge"
install_root="$HOME/Library/Application Support/CodexPulse/bin"
installed_binary="$install_root/codex-pulse-bridge"
paired_config="$HOME/Library/Application Support/CodexPulse/config.json"

swift build --package-path "$bridge_root" -c release
"$bridge_root/.build/release/codex-pulse-bridge-self-test"

if [[ -x "$installed_binary" && -f "$paired_config" ]]; then
  installed_hash=$(shasum -a 256 "$installed_binary" | awk '{print $1}')
  candidate_hash=$(shasum -a 256 "$bridge_root/.build/release/codex-pulse-bridge" | awk '{print $1}')
  if [[ "$installed_hash" != "$candidate_hash" ]]; then
    print -u2 "Refusing to overwrite a paired unsigned Bridge: its Keychain code identity would change."
    print -u2 "First uninstall service/notify, revoke the host, run local-reset with the current binary, then rerun this installer and pair again."
    exit 1
  fi
fi

mkdir -p "$install_root"
install -m 700 "$bridge_root/.build/release/codex-pulse-bridge" "$installed_binary"

echo "CodexPulse Bridge installed at: $installed_binary"
echo "Pair this Mac from the phone-generated code, then enable notify and launchd:"
echo "  '$installed_binary' pair --relay https://YOUR-DEPLOYMENT --code 12345678 --label 'Mac mini'"
echo "  '$installed_binary' notify-install --yes"
echo "  '$installed_binary' service-install --yes"
