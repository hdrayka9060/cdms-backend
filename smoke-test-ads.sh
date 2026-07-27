#!/bin/bash
# Smoke test for the read-only Marketing ads-analytics feature (Google + Meta).
#
# Runs the FULL loop in DEV-MODE (placeholder GOOGLE_ADS_* / FACEBOOK_APP_*):
#   connect/start → devMode → connect/callback (mock account) → sync (mock
#   snapshots) → analytics (aggregates) → disconnect.
# In REAL-MODE (live creds) the interactive OAuth can't be scripted, so the
# connect/sync steps are skipped per provider and only the analytics +
# connections endpoints are shape-checked.
#
# Requires both servers up + the smoke user. Same login as the other scripts.

set -e

API="http://localhost:3000/api/v1"
EMAIL="smoketest@cdms.local"
PASSWORD="SmokeTest1!"

log() { printf '\n=== %s ===\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

jget() {
  local key="$1"
  local path="${2:-data}"
  node -e '
    let s = ""; process.stdin.on("data", c => s += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        const path = process.argv[1] === "." ? [] : process.argv[1].split(".");
        const key = process.argv[2];
        let cur = j;
        for (const p of path) cur = cur?.[p];
        const v = cur?.[key];
        if (v === undefined || v === null) process.exit(0);
        process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
      } catch (e) {}
    });
  ' "$path" "$key"
}

log "Login"
TOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jget accessToken data)
[ -n "$TOKEN" ] || fail "no token"
H_AUTH="Authorization: Bearer $TOKEN"
H_JSON="Content-Type: application/json"

log "Analytics endpoint shape"
curl -s -H "$H_AUTH" "$API/marketing/ads/analytics" | node -e '
  let s = ""; process.stdin.on("data", c => s += c);
  process.stdin.on("end", () => {
    const d = (JSON.parse(s).data) || {};
    for (const k of ["summary", "byPlatform", "campaigns", "trend", "connections", "devMode", "range"]) {
      if (!(k in d)) { console.error("  missing key: " + k); process.exit(1); }
    }
    console.log("  ✓ analytics shape ok (devMode=" + JSON.stringify(d.devMode) + ")");
  });' || fail "analytics shape"

for PROVIDER in meta google; do
  log "Provider: $PROVIDER"
  START=$(curl -s -X POST "$API/marketing/ads/connect/start" -H "$H_AUTH" -H "$H_JSON" \
    -d "{\"provider\":\"$PROVIDER\"}")
  DEV=$(printf '%s' "$START" | jget devMode data)
  echo "  devMode=$DEV"
  if [ "$DEV" != "true" ]; then
    echo "  ↪ real-mode — skipping scripted OAuth connect/sync for $PROVIDER"
    continue
  fi

  curl -s -X POST "$API/marketing/ads/connect/callback" -H "$H_AUTH" -H "$H_JSON" \
    -d "{\"provider\":\"$PROVIDER\"}" > /dev/null
  ROWS=$(curl -s -X POST "$API/marketing/ads/sync" -H "$H_AUTH" -H "$H_JSON" \
    -d "{\"provider\":\"$PROVIDER\"}" | jget rows data)
  echo "  synced rows=$ROWS"
  { [ -n "$ROWS" ] && [ "$ROWS" -gt 0 ]; } 2>/dev/null || fail "$PROVIDER sync wrote no rows"

  PROV_OK=$(curl -s -H "$H_AUTH" "$API/marketing/ads/analytics?provider=$PROVIDER" | node -e '
    let s = ""; process.stdin.on("data", c => s += c);
    process.stdin.on("end", () => {
      const d = (JSON.parse(s).data) || {};
      console.log(d.campaigns && d.campaigns.length > 0 ? "yes" : "no");
    });')
  [ "$PROV_OK" = "yes" ] || fail "$PROVIDER analytics empty after sync"
  echo "  ✓ analytics populated for $PROVIDER"

  CID=$(curl -s -H "$H_AUTH" "$API/marketing/ads/connections" | node -e '
    let s = ""; process.stdin.on("data", c => s += c);
    process.stdin.on("end", () => {
      const rows = (JSON.parse(s).data) || [];
      const m = rows.find(r => r.provider === process.argv[1]);
      process.stdout.write(m ? String(m._id) : "");
    });' "$PROVIDER")
  [ -n "$CID" ] || fail "no $PROVIDER connection id to disconnect"
  curl -s -X DELETE "$API/marketing/ads/connections/$CID" -H "$H_AUTH" > /dev/null
  echo "  ✓ disconnected $PROVIDER ($CID)"
done

log "MARKETING ADS SMOKE PASSED"
