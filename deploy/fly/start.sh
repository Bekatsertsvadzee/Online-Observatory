#!/bin/bash
# Realtime first, then the two simulated agents dialling out to it over loopback, then
# the Caddy front. If any one exits, the machine exits and Fly restarts it: a demo with
# half its processes is worse than one that says it is restarting.
set -eu

: "${DEMO_AGENT_OBSERVATORY_ID:?}" "${DEMO_AGENT_DEVICE_TOKEN:?}"
: "${DEMO_NIGHT_OBSERVATORY_ID:?}" "${DEMO_NIGHT_AGENT_DEVICE_TOKEN:?}"
: "${API_UPSTREAM:?}" "${WEB_UPSTREAM:?}"

mkdir -p /data

cd /app
npm start --workspace @darkview/realtime &

# No health route: listening on the port is the signal.
until node -e "require('net').connect(4001,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; do
  sleep 1
done

agent() {
  (
    cd /app/agent
    DARKVIEW_AGENT_DRIVER_MODE=SIMULATED \
    DARKVIEW_AGENT_CLOUD_URL=ws://127.0.0.1:4001/ws/agent \
    DARKVIEW_AGENT_OBSERVATORY_ID="$1" \
    DARKVIEW_AGENT_DEVICE_TOKEN="$2" \
    DARKVIEW_AGENT_SITE_LATITUDE="$3" \
    DARKVIEW_AGENT_SITE_LONGITUDE="$4" \
    DARKVIEW_AGENT_STATE_PATH="/data/$5-state.sqlite3" \
    DARKVIEW_AGENT_ENV_FILE="/data/$5.env" \
      exec /opt/agent/bin/python -m darkview_agent
  ) &
}

# Tbilisi, and the night-side simulator on Mauna Kea (RUNBOOK §2, Seeding).
agent "$DEMO_AGENT_OBSERVATORY_ID" "$DEMO_AGENT_DEVICE_TOKEN" 41.7151 44.8271 agent
agent "$DEMO_NIGHT_OBSERVATORY_ID" "$DEMO_NIGHT_AGENT_DEVICE_TOKEN" 19.8207 -155.4681 night

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &

wait -n
exit 1
