#!/bin/bash

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_PATH="${HOME}/Library/LaunchAgents/com.balamenon.footer-telemetry.plist"
LOG_DIR="${HOME}/Library/Logs"
INSTALL_DIR="${HOME}/Library/Application Support/FooterTelemetry"
RUN_SCRIPT="${INSTALL_DIR}/push-footer-telemetry.sh"
ENV_SOURCE="${SCRIPT_DIR}/footer-telemetry.env"
ENV_TARGET="${INSTALL_DIR}/footer-telemetry.env"
USER_DOMAIN="gui/$(id -u)"
LABEL="com.balamenon.footer-telemetry"

mkdir -p "$(dirname "$PLIST_PATH")" "$LOG_DIR" "$INSTALL_DIR"

/bin/cp "${SCRIPT_DIR}/push-footer-telemetry.sh" "$RUN_SCRIPT"
/bin/chmod 755 "$RUN_SCRIPT"

if [[ -f "$ENV_SOURCE" ]]; then
  /bin/cp "$ENV_SOURCE" "$ENV_TARGET"
  /bin/chmod 600 "$ENV_TARGET"
fi

cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.balamenon.footer-telemetry</string>
  <key>ProgramArguments</key>
  <array>
    <string>${RUN_SCRIPT}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/footer-telemetry.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/footer-telemetry.log</string>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$PLIST_PATH" >/dev/null
/bin/launchctl bootout "$USER_DOMAIN" "$PLIST_PATH" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "$USER_DOMAIN" "$PLIST_PATH"
/bin/launchctl enable "${USER_DOMAIN}/${LABEL}"
/bin/launchctl kickstart -k "${USER_DOMAIN}/${LABEL}" >/dev/null 2>&1 || true

printf 'Installed LaunchAgent: %s\n' "$PLIST_PATH"
