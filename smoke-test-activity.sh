#!/bin/bash
# Smoke test for the activity log + dashboard endpoint.
#
# 1. Login, hit /dashboard/activity baseline.
# 2. Create vehicle + buyer + lead + close-lead (sale) — five actions in
#    different modules, all should appear in the feed.
# 3. Update the vehicle's status, soft-delete the lead — three more entries.
# 4. Fetch activity again, assert each expected entry surfaced.

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
SUFFIX=$(date +%s)

log "Bootstrap entities (vehicle / buyer / lead)"
BUYER=$(curl -s -X POST "$API/crm/buyers" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyerName\":\"Activity Buyer $SUFFIX\",\"buyerEmail\":\"act.$SUFFIX@example.com\",\"buyerPhone\":\"+15555550911\"}" | jget _id data)
VEHICLE=$(curl -s -X POST "$API/inventory" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"title\":\"Activity Car $SUFFIX\",\"company\":\"Activity\",\"model\":\"Log\",\"year\":2024,\"price\":18000,\"costPrice\":12000,\"fuelType\":\"petrol\",\"transmission\":\"automatic\",\"status\":\"unsold\",\"bodyType\":\"Sedan\"}" | jget _id data)
LEAD=$(curl -s -X POST "$API/leads" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyer\":\"$BUYER\",\"vehicle\":\"$VEHICLE\",\"source\":\"website\",\"status\":\"new\"}" | jget _id data)
[ -n "$BUYER" ] && [ -n "$VEHICLE" ] && [ -n "$LEAD" ] || fail "bootstrap"
echo "buyer=$BUYER vehicle=$VEHICLE lead=$LEAD"

log "Mutations: close lead, then PATCH the (now sold) vehicle's price"
curl -s -X POST "$API/leads/$LEAD/close" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"soldAt":17500,"paymentMethod":"cash","paymentStatus":"paid","amountPaid":17500}' > /dev/null
curl -s -X PATCH "$API/inventory/$VEHICLE" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"price":18500}' > /dev/null

log "Fetch activity feed (latest 50)"
FEED_JSON=$(curl -s -H "$H_AUTH" "$API/dashboard/activity?limit=50")
# Activity entries from this run: filter by the smoke-test SUFFIX baked into
# the labels. Catches sale-recorded too (its entityId is the Sale's, not the
# Vehicle's).
EXTRACT=$(printf '%s' "$FEED_JSON" | node -e '
  let s = ""; process.stdin.on("data", c => s += c);
  process.stdin.on("end", () => {
    const j = JSON.parse(s);
    const rows = j.data ?? [];
    const suffix = process.argv[1];
    const ours = rows.filter(r => (r.label || "").includes(suffix));
    for (const r of ours) {
      console.log(`${r.module}/${r.action} | ${r.entity} | ${r.label} | by ${r.by}`);
    }
  });
' "$SUFFIX")
echo "$EXTRACT"

# Expected: at least one entry from each of these modules tied to our IDs.
expect_match() {
  local pattern="$1"
  local label="$2"
  if printf '%s\n' "$EXTRACT" | grep -q "$pattern"; then
    echo "  ✓ $label"
  else
    fail "missing entry: $label (pattern: $pattern)"
  fi
}

log "Assertions"
expect_match "^crm-buyers/created"      "Buyer created"
expect_match "^inventory/created"       "Vehicle created"
expect_match "^leads/created"           "Lead created"
expect_match "^accounting/sale-recorded" "Sale recorded"
expect_match "^leads/closed"            "Lead closed"
expect_match "^inventory/updated"       "Vehicle price PATCH"

log "ACTIVITY LOG SMOKE PASSED"
