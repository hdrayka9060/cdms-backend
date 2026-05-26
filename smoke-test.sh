#!/bin/bash
# End-to-end smoke test for the inverse-transition cascade.
#
# Walks the happy path:
#   1. Create a buyer (CRM Buyer)
#   2. Create a vehicle (Inventory)
#   3. Create a lead linking them
#   4. Close the lead via the close endpoint (creates Sale, flips vehicle to sold)
#   5. Edit the vehicle's status back to Unsold
#   6. Assert: lead is now Archived (not soft-deleted)
#
# Run while the backend is up. Prints each step's result.

set -e

API="http://localhost:3000/api/v1"
EMAIL="smoketest@cdms.local"
PASSWORD="SmokeTest1!"

log() { printf '\n=== %s ===\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# JSON value extractor. Walks the response envelope and pulls the field from
# the TOP-LEVEL data object (not nested subdocs — which is why a naive grep
# kept picking up traffic._id instead of vehicle._id).
#
# Usage:
#   jget <field>            → look inside .data
#   jget <field> .          → look at the top-level (e.g. for accessToken)
#   jget <field> data.user  → arbitrary dotted path inside the envelope
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
LOGIN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(printf '%s' "$LOGIN" | jget accessToken data)
[ -n "$TOKEN" ] || fail "no accessToken — login response: $LOGIN"
echo "got token (len=${#TOKEN})"

H_AUTH="Authorization: Bearer $TOKEN"
H_JSON="Content-Type: application/json"

log "Create buyer"
BUYER_RES=$(curl -s -X POST "$API/crm/buyers" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"buyerName":"Smoke Buyer","buyerEmail":"smoke.buyer@example.com","buyerPhone":"+15555550100","budget":15000,"stage":"new"}')
BUYER_ID=$(printf '%s' "$BUYER_RES" | jget _id data)
[ -n "$BUYER_ID" ] || fail "no buyer id — response: $BUYER_RES"
echo "buyer=$BUYER_ID"

log "Create vehicle"
VEHICLE_RES=$(curl -s -X POST "$API/inventory" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"title":"Smoke Test Car","company":"Test","model":"Model Z","year":2022,"price":12500,"costPrice":9000,"fuelType":"petrol","transmission":"automatic","status":"unsold"}')
VEHICLE_ID=$(printf '%s' "$VEHICLE_RES" | jget _id data)
[ -n "$VEHICLE_ID" ] || fail "no vehicle id — response: $VEHICLE_RES"
echo "vehicle=$VEHICLE_ID"

log "Create lead"
LEAD_RES=$(curl -s -X POST "$API/leads" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyer\":\"$BUYER_ID\",\"vehicle\":\"$VEHICLE_ID\",\"source\":\"website\",\"status\":\"new\",\"notes\":\"smoke\"}")
LEAD_ID=$(printf '%s' "$LEAD_RES" | jget _id data)
[ -n "$LEAD_ID" ] || fail "no lead id — response: $LEAD_RES"
echo "lead=$LEAD_ID"

log "Close lead (sale)"
CLOSE_RES=$(curl -s -X POST "$API/leads/$LEAD_ID/close" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"soldAt":12000,"paymentMethod":"cash","paymentStatus":"paid","amountPaid":12000}')
echo "close response (first 400 chars):"
echo "${CLOSE_RES:0:400}"

LEAD_STATUS=$(curl -s -H "$H_AUTH" "$API/leads/$LEAD_ID" | jget status data)
echo "lead.status after close = $LEAD_STATUS  (expected: closed)"
[ "$LEAD_STATUS" = "closed" ] || fail "expected closed, got $LEAD_STATUS"

VEHICLE_STATUS=$(curl -s -H "$H_AUTH" "$API/inventory/$VEHICLE_ID" | jget status data)
echo "vehicle.status after close = $VEHICLE_STATUS  (expected: sold)"
[ "$VEHICLE_STATUS" = "sold" ] || fail "expected sold, got $VEHICLE_STATUS"

log "Flip vehicle Sold -> Unsold (triggers cleanup)"
PATCH_RES=$(curl -s -X PATCH "$API/inventory/$VEHICLE_ID" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"status":"unsold"}')
echo "patch response (first 300 chars):"
echo "${PATCH_RES:0:300}"

# Brief pause to let the parallel cleanup queries land (they're awaited but
# the response can technically race with the lean read; one second is plenty).
sleep 1

log "Read lead after vehicle un-sell"
LEAD_AFTER=$(curl -s -H "$H_AUTH" "$API/leads/$LEAD_ID")
LEAD_STATUS_AFTER=$(printf '%s' "$LEAD_AFTER" | jget status data)
LEAD_DELETED_AFTER=$(printf '%s' "$LEAD_AFTER" | jget isDeleted data)
echo "lead.status = $LEAD_STATUS_AFTER  (expected: archived)"
echo "lead.isDeleted = $LEAD_DELETED_AFTER  (expected: false)"
[ "$LEAD_STATUS_AFTER" = "archived" ] || fail "expected archived, got $LEAD_STATUS_AFTER"
[ "$LEAD_DELETED_AFTER" = "false" ] || fail "expected isDeleted=false, got $LEAD_DELETED_AFTER"

log "Read vehicle after un-sell"
VEH_AFTER=$(curl -s -H "$H_AUTH" "$API/inventory/$VEHICLE_ID")
VEH_STATUS_AFTER=$(printf '%s' "$VEH_AFTER" | jget status data)
VEH_SOLD_AT_AFTER=$(printf '%s' "$VEH_AFTER" | jget soldAt data)
echo "vehicle.status = $VEH_STATUS_AFTER  (expected: unsold)"
echo "vehicle.soldAt = $VEH_SOLD_AT_AFTER  (expected: 0)"
[ "$VEH_STATUS_AFTER" = "unsold" ] || fail "expected unsold, got $VEH_STATUS_AFTER"

log "ALL CHECKS PASSED"
echo "lead_id=$LEAD_ID"
echo "vehicle_id=$VEHICLE_ID"
echo "buyer_id=$BUYER_ID"
