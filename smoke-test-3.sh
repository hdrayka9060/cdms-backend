#!/bin/bash
# Smoke test #3: lead status → vehicle status mapping when a CLOSED lead is
# moved back to a non-closed state via PATCH.
#
# Mapping under test:
#   archived    → unsold
#   test_drive  → test_drive
#   contacted   → pending
#   negotiation → pending
#
# Walks the same closed lead through several reverse transitions and asserts
# the linked vehicle's status follows the mapping each time. Also asserts the
# sale is soft-deleted (vehicle.soldAt cleared) on the first reverse.

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
    let s = "";
    process.stdin.on("data", c => s += c);
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
      } catch (e) { /* ignore */ }
    });
  ' "$path" "$key"
}

# Returns the vehicle.status for a given vehicle id.
veh_status() {
  curl -s -H "$H_AUTH" "$API/inventory/$1" | jget status data
}

# Returns the lead.status for a given lead id.
lead_status() {
  curl -s -H "$H_AUTH" "$API/leads/$1" | jget status data
}

# Reopen the lead by PATCHing its status; assert the resulting vehicle status.
# Args: $1 = new lead status, $2 = expected vehicle status
reopen_and_check() {
  local newLeadStatus="$1"
  local expectedVehStatus="$2"
  curl -s -X PATCH "$API/leads/$LEAD" -H "$H_AUTH" -H "$H_JSON" \
    -d "{\"status\":\"$newLeadStatus\"}" > /dev/null
  sleep 1
  local L=$(lead_status "$LEAD")
  local V=$(veh_status "$VEHICLE")
  echo "  lead → $L  (asked: $newLeadStatus)"
  echo "  vehicle → $V  (expected: $expectedVehStatus)"
  [ "$L" = "$newLeadStatus" ] || fail "lead didn't transition to $newLeadStatus, got $L"
  [ "$V" = "$expectedVehStatus" ] || fail "vehicle expected $expectedVehStatus, got $V"
}

log "Login"
TOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jget accessToken data)
[ -n "$TOKEN" ] || fail "no token"
H_AUTH="Authorization: Bearer $TOKEN"
H_JSON="Content-Type: application/json"

SUFFIX=$(date +%s)

log "Bootstrap: buyer, vehicle, lead"
BUYER=$(curl -s -X POST "$API/crm/buyers" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyerName\":\"Mapping $SUFFIX\",\"buyerEmail\":\"map.$SUFFIX@example.com\",\"buyerPhone\":\"+15555550103\"}" | jget _id data)
VEHICLE=$(curl -s -X POST "$API/inventory" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"title\":\"Mapping Car $SUFFIX\",\"company\":\"Test\",\"model\":\"Map\",\"year\":2022,\"price\":12000,\"costPrice\":8000,\"fuelType\":\"petrol\",\"transmission\":\"automatic\",\"status\":\"unsold\"}" | jget _id data)
LEAD=$(curl -s -X POST "$API/leads" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyer\":\"$BUYER\",\"vehicle\":\"$VEHICLE\",\"source\":\"website\",\"status\":\"new\"}" | jget _id data)
[ -n "$BUYER" ] && [ -n "$VEHICLE" ] && [ -n "$LEAD" ] || fail "bootstrap"
echo "buyer=$BUYER vehicle=$VEHICLE lead=$LEAD"

log "Close lead → expect lead=closed, vehicle=sold, soldAt set"
curl -s -X POST "$API/leads/$LEAD/close" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"soldAt":11000,"paymentMethod":"cash","paymentStatus":"paid","amountPaid":11000}' > /dev/null
[ "$(lead_status $LEAD)" = "closed" ] || fail "lead didn't close"
[ "$(veh_status $VEHICLE)" = "sold" ] || fail "vehicle didn't go sold"
SOLD_AT=$(curl -s -H "$H_AUTH" "$API/inventory/$VEHICLE" | jget soldAt data)
[ "$SOLD_AT" = "11000" ] || fail "soldAt expected 11000, got $SOLD_AT"

log "Reverse closed → archived (mapping: archived → unsold)"
reopen_and_check "archived" "unsold"
SOLD_AT_AFTER=$(curl -s -H "$H_AUTH" "$API/inventory/$VEHICLE" | jget soldAt data)
[ "$SOLD_AT_AFTER" = "0" ] || fail "soldAt should be cleared, got $SOLD_AT_AFTER"

# Each subsequent transition starts from a non-closed state, so we close
# again, then reopen with the next status to test.
relink_and_close() {
  curl -s -X POST "$API/leads/$LEAD/close" -H "$H_AUTH" -H "$H_JSON" \
    -d '{"soldAt":11000,"paymentMethod":"cash","paymentStatus":"paid","amountPaid":11000}' > /dev/null
  # After close, lead.status should be 'closed' and vehicle 'sold'. Quick assert.
  [ "$(lead_status $LEAD)" = "closed" ] || fail "re-close didn't go closed"
  [ "$(veh_status $VEHICLE)" = "sold" ] || fail "re-close didn't set vehicle sold"
}

log "Re-close, then reverse closed → test_drive (mapping: test_drive → test_drive)"
relink_and_close
reopen_and_check "test_drive" "test_drive"

log "Re-close, then reverse closed → contacted (mapping: contacted → pending)"
relink_and_close
reopen_and_check "contacted" "pending"

log "Re-close, then reverse closed → negotiation (mapping: negotiation → pending)"
relink_and_close
reopen_and_check "negotiation" "pending"

log "ALL MAPPING CHECKS PASSED"
