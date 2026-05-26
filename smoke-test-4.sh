#!/bin/bash
# Smoke test #4: the two delete-cascades.
#
# Scenario A: closed lead → DELETE /leads/:id
#   - lead becomes soft-deleted (404 on GET)
#   - vehicle returns to unsold (soldAt/soldDate cleared)
#   - sale row soft-deleted (not visible in ledger)
#
# Scenario B: sold vehicle → DELETE /inventory/:id
#   - vehicle becomes soft-deleted (404 on GET)
#   - the closed lead linked to it is now archived
#   - sale row soft-deleted

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

# Counts sales rows in the ledger whose vehicleId matches $1.
sales_for_vehicle() {
  curl -s -H "$H_AUTH" "$API/accounting/sales?limit=200" |
    node -e '
      let s = ""; process.stdin.on("data", c => s += c);
      process.stdin.on("end", () => {
        const j = JSON.parse(s);
        const rows = j?.data?.data ?? [];
        const id = process.argv[1];
        console.log(rows.filter(r => r.vehicleId === id).length);
      });
    ' "$1"
}

http_status() {
  # Echo just the status code from a GET request.
  curl -s -o /dev/null -w "%{http_code}" -H "$H_AUTH" "$1"
}

log "Login"
TOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jget accessToken data)
[ -n "$TOKEN" ] || fail "no token"
H_AUTH="Authorization: Bearer $TOKEN"
H_JSON="Content-Type: application/json"

SUFFIX=$(date +%s)

bootstrap() {
  # Each scenario gets its own fresh buyer / vehicle / lead so test runs are
  # independent of each other.
  local tag="$1"
  BUYER=$(curl -s -X POST "$API/crm/buyers" -H "$H_AUTH" -H "$H_JSON" \
    -d "{\"buyerName\":\"DC $tag $SUFFIX\",\"buyerEmail\":\"dc.$tag.$SUFFIX@example.com\",\"buyerPhone\":\"+15555550104\"}" | jget _id data)
  VEHICLE=$(curl -s -X POST "$API/inventory" -H "$H_AUTH" -H "$H_JSON" \
    -d "{\"title\":\"DC Car $tag $SUFFIX\",\"company\":\"Test\",\"model\":\"DC\",\"year\":2022,\"price\":10000,\"costPrice\":7000,\"fuelType\":\"petrol\",\"transmission\":\"automatic\",\"status\":\"unsold\"}" | jget _id data)
  LEAD=$(curl -s -X POST "$API/leads" -H "$H_AUTH" -H "$H_JSON" \
    -d "{\"buyer\":\"$BUYER\",\"vehicle\":\"$VEHICLE\",\"source\":\"website\",\"status\":\"new\"}" | jget _id data)
  curl -s -X POST "$API/leads/$LEAD/close" -H "$H_AUTH" -H "$H_JSON" \
    -d '{"soldAt":9500,"paymentMethod":"cash","paymentStatus":"paid","amountPaid":9500}' > /dev/null
  # Sanity: post-close baseline.
  [ "$(curl -s -H "$H_AUTH" "$API/inventory/$VEHICLE" | jget status data)" = "sold" ] || fail "$tag: vehicle didn't go sold"
  [ "$(sales_for_vehicle $VEHICLE)" = "1" ] || fail "$tag: expected 1 sale row, got $(sales_for_vehicle $VEHICLE)"
}

# ── Scenario A ────────────────────────────────────────────────────────────────
log "Scenario A: closed-lead DELETE → vehicle un-sold + sale cleaned"
bootstrap "A"
echo "buyer=$BUYER vehicle=$VEHICLE lead=$LEAD (closed)"

DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/leads/$LEAD" -H "$H_AUTH")
echo "DELETE /leads/$LEAD → http $DEL_STATUS"
[ "$DEL_STATUS" = "200" ] || fail "expected 200 on DELETE, got $DEL_STATUS"
sleep 1

LEAD_GET=$(http_status "$API/leads/$LEAD")
VEH_STATUS_A=$(curl -s -H "$H_AUTH" "$API/inventory/$VEHICLE" | jget status data)
SOLD_AT_A=$(curl -s -H "$H_AUTH" "$API/inventory/$VEHICLE" | jget soldAt data)
SALE_COUNT_A=$(sales_for_vehicle "$VEHICLE")
echo "  GET /leads/$LEAD → http $LEAD_GET   (expected 404, soft-deleted)"
echo "  vehicle.status   = $VEH_STATUS_A    (expected unsold)"
echo "  vehicle.soldAt   = $SOLD_AT_A       (expected 0)"
echo "  sale rows for V  = $SALE_COUNT_A    (expected 0)"
[ "$LEAD_GET" = "404" ] || fail "deleted lead should 404, got $LEAD_GET"
[ "$VEH_STATUS_A" = "unsold" ] || fail "vehicle not unsold: $VEH_STATUS_A"
[ "$SOLD_AT_A" = "0" ] || fail "soldAt not cleared: $SOLD_AT_A"
[ "$SALE_COUNT_A" = "0" ] || fail "sale rows not cleaned: $SALE_COUNT_A"

# ── Scenario B ────────────────────────────────────────────────────────────────
log "Scenario B: sold-vehicle DELETE → lead archived + sale cleaned"
bootstrap "B"
echo "buyer=$BUYER vehicle=$VEHICLE lead=$LEAD (closed)"

DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/inventory/$VEHICLE" -H "$H_AUTH")
echo "DELETE /inventory/$VEHICLE → http $DEL_STATUS"
[ "$DEL_STATUS" = "200" ] || fail "expected 200 on DELETE, got $DEL_STATUS"
sleep 1

VEH_GET=$(http_status "$API/inventory/$VEHICLE")
LEAD_STATUS_B=$(curl -s -H "$H_AUTH" "$API/leads/$LEAD" | jget status data)
SALE_COUNT_B=$(sales_for_vehicle "$VEHICLE")
echo "  GET /inventory/$VEHICLE → http $VEH_GET   (expected 404, soft-deleted)"
echo "  lead.status             = $LEAD_STATUS_B  (expected archived)"
echo "  sale rows for V         = $SALE_COUNT_B   (expected 0)"
[ "$VEH_GET" = "404" ] || fail "deleted vehicle should 404, got $VEH_GET"
[ "$LEAD_STATUS_B" = "archived" ] || fail "lead not archived: $LEAD_STATUS_B"
[ "$SALE_COUNT_B" = "0" ] || fail "sale rows not cleaned: $SALE_COUNT_B"

log "BOTH DELETE-CASCADE CHECKS PASSED"
