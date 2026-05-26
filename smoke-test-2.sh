#!/bin/bash
# Smoke test #2: sibling-archive cascade + Guard 2 (duplicate buyer×vehicle).
#
# Scenario:
#   1. One vehicle V, two buyers A and B.
#   2. Each buyer opens a lead on V (Lead-A and Lead-B). Both start as `new`.
#   3. Close Lead-A.
#      - Lead-A → closed
#      - Vehicle V → sold
#      - Lead-B → ARCHIVED (sibling-archive auto-fires)
#   4. Try to create another lead Buyer-A × V → REJECTED (Vehicle is sold).
#   5. Buyer-B's lead is now archived → try to create a NEW lead Buyer-B × V
#      → REJECTED (vehicle still sold; Guard 1 blocks before Guard 2 runs).
#   6. Un-sell the vehicle. Lead-A → archived; Lead-B already archived.
#   7. Now try Buyer-B × V again → ALLOWED (only archived siblings on this pair).
#   8. Try Buyer-A × V again → REJECTED (Lead-A is in some terminal state; but
#      after un-sell Lead-A is ALSO archived, so this should be allowed too).
#
# Each step prints what happened. Exits non-zero on the first failed assertion.

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

log "Login"
TOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jget accessToken data)
[ -n "$TOKEN" ] || fail "no token"
H_AUTH="Authorization: Bearer $TOKEN"
H_JSON="Content-Type: application/json"

# Unique suffix so re-runs don't collide on emails / uniqueness constraints.
SUFFIX=$(date +%s)

log "Create Buyer A and Buyer B"
BUYER_A=$(curl -s -X POST "$API/crm/buyers" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyerName\":\"Smoke A $SUFFIX\",\"buyerEmail\":\"a.$SUFFIX@example.com\",\"buyerPhone\":\"+15555550101\"}" | jget _id data)
BUYER_B=$(curl -s -X POST "$API/crm/buyers" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyerName\":\"Smoke B $SUFFIX\",\"buyerEmail\":\"b.$SUFFIX@example.com\",\"buyerPhone\":\"+15555550102\"}" | jget _id data)
[ -n "$BUYER_A" ] && [ -n "$BUYER_B" ] || fail "buyer creation failed"
echo "buyerA=$BUYER_A"
echo "buyerB=$BUYER_B"

log "Create vehicle"
VEHICLE=$(curl -s -X POST "$API/inventory" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"title\":\"Sibling Test Car $SUFFIX\",\"company\":\"Test\",\"model\":\"Sibling\",\"year\":2022,\"price\":12500,\"costPrice\":9000,\"fuelType\":\"petrol\",\"transmission\":\"automatic\",\"status\":\"unsold\"}" | jget _id data)
[ -n "$VEHICLE" ] || fail "no vehicle"
echo "vehicle=$VEHICLE"

log "Create two leads (different buyers, same vehicle)"
LEAD_A=$(curl -s -X POST "$API/leads" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyer\":\"$BUYER_A\",\"vehicle\":\"$VEHICLE\",\"source\":\"website\",\"status\":\"new\"}" | jget _id data)
LEAD_B=$(curl -s -X POST "$API/leads" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyer\":\"$BUYER_B\",\"vehicle\":\"$VEHICLE\",\"source\":\"website\",\"status\":\"new\"}" | jget _id data)
[ -n "$LEAD_A" ] && [ -n "$LEAD_B" ] || fail "lead creation failed"
echo "leadA=$LEAD_A"
echo "leadB=$LEAD_B"

log "Guard 2 check: same buyer A × same vehicle → expect 409"
DUP_RES=$(curl -s -X POST "$API/leads" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyer\":\"$BUYER_A\",\"vehicle\":\"$VEHICLE\",\"source\":\"website\",\"status\":\"new\"}")
DUP_CODE=$(printf '%s' "$DUP_RES" | jget statusCode .)
DUP_MSG=$(printf '%s' "$DUP_RES" | jget message .)
echo "statusCode=$DUP_CODE  message=$DUP_MSG"
[ "$DUP_CODE" = "409" ] || fail "expected 409 on duplicate buyer×vehicle, got $DUP_CODE"

log "Close Lead A (sale recorded; triggers sibling-archive on Lead B)"
curl -s -X POST "$API/leads/$LEAD_A/close" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"soldAt":12000,"paymentMethod":"cash","paymentStatus":"paid","amountPaid":12000}' > /dev/null

LEAD_A_STATUS=$(curl -s -H "$H_AUTH" "$API/leads/$LEAD_A" | jget status data)
LEAD_B_STATUS=$(curl -s -H "$H_AUTH" "$API/leads/$LEAD_B" | jget status data)
echo "leadA.status = $LEAD_A_STATUS  (expected: closed)"
echo "leadB.status = $LEAD_B_STATUS  (expected: archived)"
[ "$LEAD_A_STATUS" = "closed" ] || fail "expected leadA closed, got $LEAD_A_STATUS"
[ "$LEAD_B_STATUS" = "archived" ] || fail "expected leadB archived (sibling-archive cascade failed), got $LEAD_B_STATUS"

log "Guard 1 check: new lead on sold vehicle → expect 409"
SOLD_RES=$(curl -s -X POST "$API/leads" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyer\":\"$BUYER_B\",\"vehicle\":\"$VEHICLE\",\"source\":\"website\",\"status\":\"new\"}")
SOLD_CODE=$(printf '%s' "$SOLD_RES" | jget statusCode .)
SOLD_MSG=$(printf '%s' "$SOLD_RES" | jget message .)
echo "statusCode=$SOLD_CODE  message=$SOLD_MSG"
[ "$SOLD_CODE" = "409" ] || fail "expected 409 on sold-vehicle lead, got $SOLD_CODE"

log "Un-sell the vehicle (inverse transition)"
curl -s -X PATCH "$API/inventory/$VEHICLE" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"status":"unsold"}' > /dev/null
sleep 1
LEAD_A_AFTER=$(curl -s -H "$H_AUTH" "$API/leads/$LEAD_A" | jget status data)
VEH_AFTER=$(curl -s -H "$H_AUTH" "$API/inventory/$VEHICLE" | jget status data)
echo "vehicle.status = $VEH_AFTER  (expected: unsold)"
echo "leadA.status   = $LEAD_A_AFTER  (expected: archived, was closed)"
[ "$VEH_AFTER" = "unsold" ] || fail "vehicle didn't un-sell"
[ "$LEAD_A_AFTER" = "archived" ] || fail "expected leadA archived after un-sell, got $LEAD_A_AFTER"

log "Guard 2 release check: buyer B × vehicle (existing lead is archived) → expect 201"
ALLOW_RES=$(curl -s -X POST "$API/leads" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyer\":\"$BUYER_B\",\"vehicle\":\"$VEHICLE\",\"source\":\"website\",\"status\":\"new\"}")
ALLOW_CODE=$(printf '%s' "$ALLOW_RES" | jget statusCode .)
echo "statusCode=$ALLOW_CODE  (expected: 201)"
[ "$ALLOW_CODE" = "201" ] || fail "expected 201 when only archived lead exists, got $ALLOW_CODE — response: $ALLOW_RES"

log "ALL SIBLING / GUARD CHECKS PASSED"
