#!/bin/bash
# Realtime first, then the two simulated agents dialling out to it over loopback, then
# the Caddy front. If any one exits, the machine exits and Fly restarts it: a demo with
# half its processes is worse than one that says it is restarting.
set -eu

: "${DEMO_AGENT_OBSERVATORY_ID:?}" "${DEMO_AGENT_DEVICE_TOKEN:?}"
: "${DEMO_NIGHT_OBSERVATORY_ID:?}" "${DEMO_NIGHT_AGENT_DEVICE_TOKEN:?}"
: "${API_UPSTREAM:?}" "${WEB_UPSTREAM:?}"

# `fly storage create` sets the Tigris bucket's credentials under the AWS names; the
# storage package reads S3_* (ADR-012). An S3_* secret, if set, wins.
export S3_ENDPOINT="${S3_ENDPOINT:-${AWS_ENDPOINT_URL_S3:-}}"
export S3_REGION="${S3_REGION:-${AWS_REGION:-}}"
export S3_BUCKET="${S3_BUCKET:-${BUCKET_NAME:-}}"
export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-${AWS_ACCESS_KEY_ID:-}}"
export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-${AWS_SECRET_ACCESS_KEY:-}}"

mkdir -p /data

# This script is PID 1. Fly stops the machine with a signal to it, and a shell does
# not pass one on to background jobs by itself; without this the stop waits out
# kill_timeout and the agents are killed mid-heartbeat instead of exiting.
trap 'kill 0' TERM INT

cd /app
npm start --workspace @darkview/realtime &

# Bounded. A realtime that never listens -- the database unreachable, a secret
# missing -- used to leave this loop spinning for the life of the machine, with no
# front up to fail the health check: a machine "started" and serving nothing.
waited=0
until node -e "require('net').connect(4001,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; do
  waited=$((waited + 1))
  if [ "$waited" -ge 60 ]; then
    echo "start.sh: realtime did not listen on 4001 within 60 s" >&2
    exit 1
  fi
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
