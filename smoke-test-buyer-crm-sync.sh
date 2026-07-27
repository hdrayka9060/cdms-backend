#!/bin/bash
# Smoke test: Leads → Buyer CRM record sync.
#   1. Creating a lead adds the vehicle to buyer.interestedVehicles
#   2. Booking a test drive via the lead adds a test_drive_booked history entry
#   3. Closing the lead adds a buyer.purchases entry (+ stage=purchased)
# Run while the backend is up.
set -e

API="http://localhost:3000/api/v1"
EMAIL="smoketest@cdms.local"
PASSWORD="SmokeTest1!"

log()  { printf '\n=== %s ===\n' "$1"; }
pass() { printf '  PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

jget() {
  node -e '
    let s=""; process.stdin.on("data",c=>s+=c);
    process.stdin.on("end",()=>{ try{
      const j=JSON.parse(s);
      let cur=j; for(const p of (process.argv[1]?process.argv[1].split("."):[])) cur=cur?.[p];
      process.stdout.write(cur==null?"":(typeof cur==="object"?JSON.stringify(cur):String(cur)));
    }catch(e){process.stdout.write("");} });
  ' "$1"
}
jsx() {
  node -e '
    let s=""; process.stdin.on("data",c=>s+=c);
    process.stdin.on("end",()=>{ try{
      const j=JSON.parse(s);
      const v=(new Function("j","return ("+process.argv[1]+")"))(j);
      process.stdout.write(v===undefined||v===null?"":(typeof v==="object"?JSON.stringify(v):String(v)));
    }catch(e){process.stdout.write("ERR:"+e.message);} });
  ' "$1"
}
iso(){ node -e "console.log(new Date(Date.now()+($1)).toISOString())"; }

log "Login"
TOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jget data.accessToken)
[ -n "$TOKEN" ] || fail "no token"
A="Authorization: Bearer $TOKEN"; J="Content-Type: application/json"
pass "token len=${#TOKEN}"

log "Create buyer + vehicle + lead"
BUYER_ID=$(curl -s -X POST "$API/crm/buyers" -H "$A" -H "$J" \
  -d '{"buyerName":"Sync Buyer","buyerEmail":"sync.buyer@example.com","buyerPhone":"+15555557777","budget":20000,"stage":"new"}' | jget data._id)
VEH_ID=$(curl -s -X POST "$API/inventory" -H "$A" -H "$J" \
  -d '{"title":"Sync Car","company":"Test","model":"SX","year":2023,"price":19000,"costPrice":15000,"fuelType":"petrol","transmission":"automatic","status":"unsold"}' | jget data._id)
[ -n "$BUYER_ID" ] && [ -n "$VEH_ID" ] || fail "fixture create failed"
# Buyer should start with NO interested vehicles.
BEFORE=$(curl -s -H "$A" "$API/crm/buyers/$BUYER_ID" | jsx 'j.data.interestedVehicles.length')
echo "  interestedVehicles before lead = $BEFORE"
LEAD_ID=$(curl -s -X POST "$API/leads" -H "$A" -H "$J" \
  -d "{\"buyer\":\"$BUYER_ID\",\"vehicle\":\"$VEH_ID\",\"source\":\"website\",\"status\":\"new\"}" | jget data._id)
[ -n "$LEAD_ID" ] || fail "lead create failed"
pass "buyer=$BUYER_ID vehicle=$VEH_ID lead=$LEAD_ID"

log "1) Lead created → vehicle in buyer.interestedVehicles"
B=$(curl -s -H "$A" "$API/crm/buyers/$BUYER_ID")
HAS_VEH=$(printf '%s' "$B" | jsx "j.data.interestedVehicles.some(v=>String(v._id)===\"$VEH_ID\")")
[ "$HAS_VEH" = "true" ] || fail "vehicle not added to interestedVehicles: $(printf '%s' "$B" | jget data.interestedVehicles)"
pass "vehicle present in interestedVehicles"

log "1b) Add comm log to lead → buyer.communications synced (with vehicle)"
curl -s -X POST "$API/leads/$LEAD_ID/log" -H "$A" -H "$J" \
  -d '{"channel":"email","summary":"INTERNAL: sent brochure + pricing"}' >/dev/null
B=$(curl -s -H "$A" "$API/crm/buyers/$BUYER_ID")
HAS_COMM=$(printf '%s' "$B" | jsx 'j.data.communications.some(c=>c.channel==="email")')
[ "$HAS_COMM" = "true" ] || fail "comm not synced to buyer: $(printf '%s' "$B" | jget data.communications)"
COMM_VEH=$(printf '%s' "$B" | jsx 'j.data.communications.some(c=>c.channel==="email" && (c.vehicle||c.vehicleTitle))')
[ "$COMM_VEH" = "true" ] || fail "comm synced but vehicle not attached"
pass "comm synced to buyer with vehicle attached"

log "2) Book test drive via lead → buyer history test_drive_booked"
curl -s -X POST "$API/leads/$LEAD_ID/book-test-drive" -H "$A" -H "$J" \
  -d "{\"scheduledAt\":\"$(iso 86400000)\"}" >/dev/null
B=$(curl -s -H "$A" "$API/crm/buyers/$BUYER_ID")
HAS_TD=$(printf '%s' "$B" | jsx "j.data.history.some(h=>h.action===\"test_drive_booked\" && String(h.vehicleId)===\"$VEH_ID\")")
[ "$HAS_TD" = "true" ] || fail "no test_drive_booked history: $(printf '%s' "$B" | jget data.history)"
pass "test_drive_booked present in buyer history"

log "3) Close lead → buyer.purchases entry + stage purchased"
curl -s -X POST "$API/leads/$LEAD_ID/close" -H "$A" -H "$J" \
  -d '{"soldAt":18500,"paymentMethod":"cash","paymentStatus":"paid","amountPaid":18500}' >/dev/null
B=$(curl -s -H "$A" "$API/crm/buyers/$BUYER_ID")
HAS_PUR=$(printf '%s' "$B" | jsx 'j.data.purchases.length>=1')
STAGE=$(printf '%s' "$B" | jget data.stage)
[ "$HAS_PUR" = "true" ] || fail "no purchases after close: $(printf '%s' "$B" | jget data.purchases)"
[ "$STAGE" = "purchased" ] || fail "expected stage purchased, got $STAGE"
pass "purchase present + stage=purchased"

log "ALL CHECKS PASSED"
echo "buyer=$BUYER_ID vehicle=$VEH_ID lead=$LEAD_ID"
