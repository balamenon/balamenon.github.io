#!/bin/bash

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ENV_FILE="${SCRIPT_DIR}/footer-telemetry.env"
ENV_FILE="${FOOTER_TELEMETRY_ENV_FILE:-$DEFAULT_ENV_FILE}"
PMSET_BIN="/usr/bin/pmset"
NETWORK_QUALITY_BIN="/usr/bin/networkQuality"
ROUTE_BIN="/sbin/route"
NETWORKSETUP_BIN="/usr/sbin/networksetup"
CURL_BIN="/usr/bin/curl"
DATE_BIN="/bin/date"
NODE_BIN="$(command -v node || true)"
SPEEDTEST_BIN="$(command -v speedtest || true)"

log() {
  printf '[footer-telemetry] %s\n' "$*" >&2
}

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

API_BASE="${FOOTER_TELEMETRY_API_BASE:-https://bala-notes-worker.menon-bala.workers.dev}"
API_BASE="${API_BASE%/}"
TOKEN="${FOOTER_TELEMETRY_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "FOOTER_TELEMETRY_TOKEN is required. Set it in $ENV_FILE or the environment." >&2
  exit 1
fi

json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

read_battery_percent() {
  if [[ ! -x "$PMSET_BIN" ]]; then
    log "pmset not available at $PMSET_BIN"
    return 1
  fi

  local battery_output battery_percent
  battery_output="$("$PMSET_BIN" -g batt 2>/dev/null || true)"
  battery_percent="$(printf '%s\n' "$battery_output" | awk 'match($0, /[0-9]+%/) { print substr($0, RSTART, RLENGTH - 1); exit }')"

  if [[ -n "${battery_percent:-}" ]]; then
    printf '%s' "$battery_percent"
    return 0
  fi

  log "could not parse battery percentage from pmset output"
  return 1
}

read_network_speeds() {
  local download="" upload=""

  if [[ -n "$SPEEDTEST_BIN" ]]; then
    local speedtest_json
    log "probing network speeds with speedtest CLI"
    speedtest_json="$("$SPEEDTEST_BIN" --secure --json 2>/dev/null || true)"
    if [[ -n "$speedtest_json" ]]; then
      if [[ -n "$NODE_BIN" ]]; then
        download="$(printf '%s' "$speedtest_json" | "$NODE_BIN" -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data);let value="";if(json.download&&typeof json.download==="object"&&typeof json.download.bandwidth==="number"){value=json.download.bandwidth*8/1000000;}else if(typeof json.download==="number"){value=json.download/1000000;}process.stdout.write(String(value));});' 2>/dev/null || printf '%s' "$download")"
        upload="$(printf '%s' "$speedtest_json" | "$NODE_BIN" -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const json=JSON.parse(data);let value="";if(json.upload&&typeof json.upload==="object"&&typeof json.upload.bandwidth==="number"){value=json.upload.bandwidth*8/1000000;}else if(typeof json.upload==="number"){value=json.upload/1000000;}process.stdout.write(String(value));});' 2>/dev/null || printf '%s' "$upload")"
      else
        log "speedtest CLI found but node is unavailable, so JSON parsing cannot run"
      fi
    else
      log "speedtest CLI did not return JSON output"
    fi
  else
    log "speedtest CLI not found; falling back to networkQuality"
  fi

  if [[ -z "$download" || -z "$upload" ]] && [[ -x "$NETWORK_QUALITY_BIN" ]]; then
    local output
    log "probing network speeds with networkQuality"
    output="$("$NETWORK_QUALITY_BIN" -s 2>/dev/null || true)"
    download="$(printf '%s\n' "$output" | awk '
      {
        line = tolower($0)
        if (line ~ /download capacity:/ || line ~ /downlink capacity:/ || line ~ /current download capacity:/) {
          if (match($0, /[0-9]+(\.[0-9]+)? Mbps/)) {
            value = substr($0, RSTART, RLENGTH)
            sub(/ Mbps$/, "", value)
            print value
            exit
          }
        }
      }
    ')"
    upload="$(printf '%s\n' "$output" | awk '
      {
        line = tolower($0)
        if (line ~ /upload capacity:/ || line ~ /uplink capacity:/ || line ~ /current upload capacity:/) {
          if (match($0, /[0-9]+(\.[0-9]+)? Mbps/)) {
            value = substr($0, RSTART, RLENGTH)
            sub(/ Mbps$/, "", value)
            print value
            exit
          }
        }
      }
    ')"
    if [[ -z "$download" || -z "$upload" ]]; then
      log "networkQuality returned no usable speed values"
    fi
  elif [[ -z "$download" || -z "$upload" ]]; then
    log "no speed probe available; install Ookla speedtest CLI or use macOS networkQuality"
  fi

  printf '%s|%s' "$download" "$upload"
}

read_connection_label() {
  local default_interface wifi_device airport_network
  default_interface="$("$ROUTE_BIN" get default 2>/dev/null | awk '/interface: / { print $2; exit }')"

  if [[ -x "$NETWORKSETUP_BIN" ]]; then
    wifi_device="$("$NETWORKSETUP_BIN" -listallhardwareports 2>/dev/null | awk '
      /Hardware Port: Wi-Fi/ { wifi=1; next }
      wifi && /Device: / { print $2; exit }
    ')"
    if [[ -n "$wifi_device" ]]; then
      airport_network="$("$NETWORKSETUP_BIN" -getairportnetwork "$wifi_device" 2>/dev/null || true)"
      if [[ "$airport_network" == Current\ Wi-Fi\ Network:* ]]; then
        printf 'Wi-Fi'
        return 0
      fi
    fi
  fi

  if [[ -n "$default_interface" ]]; then
    printf '%s' "$default_interface"
    return 0
  fi

  return 1
}

battery_percent="$(read_battery_percent || true)"
speed_values="$(read_network_speeds)"
download_mbps="${speed_values%%|*}"
upload_mbps="${speed_values##*|}"
connection_label="$(read_connection_label || true)"
measured_at="$("$DATE_BIN" -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ -z "$battery_percent" && -z "$download_mbps" && -z "$upload_mbps" ]]; then
  log "could not collect any telemetry values on this machine"
  exit 1
fi

payload="{"
payload+="\"battery_percent\":${battery_percent:-null},"
payload+="\"download_mbps\":${download_mbps:-null},"
payload+="\"upload_mbps\":${upload_mbps:-null},"
if [[ -n "$connection_label" ]]; then
  payload+="\"connection_label\":\"$(json_escape "$connection_label")\","
else
  payload+="\"connection_label\":null,"
fi
payload+="\"measured_at\":\"${measured_at}\""
payload+="}"

"$CURL_BIN" --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  --data "$payload" \
  "${API_BASE}/api/footer-telemetry" >/dev/null

log "battery=${battery_percent:-n/a} download=${download_mbps:-n/a} upload=${upload_mbps:-n/a} connection=${connection_label:-n/a}"
printf 'Pushed footer telemetry at %s\n' "$measured_at"
