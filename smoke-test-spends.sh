#!/bin/bash
# Smoke test for the vehicle reconditioning-spend feature.
#
# Walks:
#   1. Create a vehicle (costPrice 9000)
#   2. Add two spends (500 Repair + 300 Parts) → spends[] has 2, sum 800
#   3. Create buyer + lead, close the lead (records a Sale)
#   4. Assert Sale.totalSpend == 800 (snapshotted from the vehicle)
#   5. Adding a spend on the now-SOLD vehicle → 400 (blocked)
#   6. Delete one spend (300) on the sold vehicle → 200
#   7. Assert Sale.totalSpend re-synced to 500
#
# Run while the backend is up.

set -e

API="http://localhost:3000/api/v1"
EMAIL="smoketest@cdms.local"
PASSWORD="SmokeTest1!"

log() { printf '\n=== %s ===\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# Top-level envelope field extractor (mirrors the other smoke scripts).
jget() {
  local key="$1"; local path="${2:-data}"
  node -e '
    let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{
      try { const j=JSON.parse(s);
        const path = process.argv[1]==="." ? [] : process.argv[1].split(".");
        const key = process.argv[2]; let cur=j;
        for (const p of path) cur=cur?.[p];
        const v=cur?.[key];
        if (v===undefined||v===null) process.exit(0);
        process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v));
      } catch(e){}
    });
  ' "$path" "$key"
}

# Number of spends on a vehicle GET response.
spendCount() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j?.data?.spends||[]).length));}catch(e){process.stdout.write("ERR");}});'
}
# First spend _id from a vehicle GET response.
firstSpendId() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const sp=(j?.data?.spends||[])[0];process.stdout.write(sp?String(sp._id):"");}catch(e){}});'
}
# Sale.totalSpend for a given vehicleId from a /accounting/sales list response.
saleSpendForVehicle() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const arr=j?.data?.data||[];const sale=arr.find(x=>String(x.vehicleId)===String(process.argv[1]));process.stdout.write(sale?String(sale.totalSpend??"MISSING"):"NO_SALE");}catch(e){process.stdout.write("ERR");}});' "$1"
}

log "Login"
TOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jget accessToken data)
[ -n "$TOKEN" ] || fail "no accessToken"
H_AUTH="Authorization: Bearer $TOKEN"; H_JSON="Content-Type: application/json"
echo "got token"

log "Create vehicle (costPrice 9000)"
VEHICLE_ID=$(curl -s -X POST "$API/inventory" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"title":"Spend Test Car","company":"Test","model":"Recon","year":2022,"price":12500,"costPrice":9000,"status":"unsold"}' | jget _id data)
[ -n "$VEHICLE_ID" ] || fail "no vehicle id"
echo "vehicle=$VEHICLE_ID"

log "Add spend #1 (500 Repair)"
ADD1=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/inventory/$VEHICLE_ID/spends" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"amount":500,"category":"Repair","description":"brake pads"}')
echo "http=$ADD1 (expect 201)"; [ "$ADD1" = "201" ] || fail "add spend #1 expected 201, got $ADD1"

log "Add spend #2 (300 Parts)"
ADD2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/inventory/$VEHICLE_ID/spends" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"amount":300,"category":"Parts"}')
echo "http=$ADD2 (expect 201)"; [ "$ADD2" = "201" ] || fail "add spend #2 expected 201, got $ADD2"

VEH=$(curl -s -H "$H_AUTH" "$API/inventory/$VEHICLE_ID")
CNT=$(printf '%s' "$VEH" | spendCount)
echo "spends count = $CNT (expect 2)"; [ "$CNT" = "2" ] || fail "expected 2 spends, got $CNT"

log "Create buyer + lead, close lead (records Sale)"
BUYER_ID=$(curl -s -X POST "$API/crm/buyers" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"buyerName":"Spend Buyer","buyerEmail":"spend.buyer@example.com","buyerPhone":"+15555550199","budget":15000,"stage":"new"}' | jget _id data)
LEAD_ID=$(curl -s -X POST "$API/leads" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"buyer\":\"$BUYER_ID\",\"vehicle\":\"$VEHICLE_ID\",\"source\":\"website\",\"status\":\"new\"}" | jget _id data)
[ -n "$LEAD_ID" ] || fail "no lead id"
curl -s -X POST "$API/leads/$LEAD_ID/close" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"soldAt":12000,"paymentMethod":"cash","paymentStatus":"paid","amountPaid":12000}' > /dev/null
echo "lead closed → sale recorded"

log "Assert Sale.totalSpend == 800 (snapshot)"
SP=$(curl -s -H "$H_AUTH" "$API/accounting/sales?limit=100" | saleSpendForVehicle "$VEHICLE_ID")
echo "sale.totalSpend = $SP (expect 800)"; [ "$SP" = "800" ] || fail "expected Sale.totalSpend=800, got $SP"

log "Add spend on SOLD vehicle → expect 400"
ADD3=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/inventory/$VEHICLE_ID/spends" -H "$H_AUTH" -H "$H_JSON" \
  -d '{"amount":100,"category":"Detailing"}')
echo "http=$ADD3 (expect 400)"; [ "$ADD3" = "400" ] || fail "expected 400 adding spend to sold vehicle, got $ADD3"

log "Delete one spend on the sold vehicle → re-sync Sale"
SPEND_ID=$(printf '%s' "$VEH" | firstSpendId)
[ -n "$SPEND_ID" ] || fail "could not read a spend id"
DEL=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/inventory/$VEHICLE_ID/spends/$SPEND_ID" -H "$H_AUTH")
echo "http=$DEL (expect 200)"; [ "$DEL" = "200" ] || fail "delete spend expected 200, got $DEL"

sleep 1
log "Assert Sale.totalSpend re-synced"
SP2=$(curl -s -H "$H_AUTH" "$API/accounting/sales?limit=100" | saleSpendForVehicle "$VEHICLE_ID")
echo "sale.totalSpend after delete = $SP2 (expect 300, since the 500 entry was removed)"
[ "$SP2" = "300" ] || fail "expected re-synced Sale.totalSpend=300, got $SP2"

log "Edit the remaining spend (300 → 450) on the SOLD vehicle → re-sync Sale"
VEH2=$(curl -s -H "$H_AUTH" "$API/inventory/$VEHICLE_ID")
SPEND_ID2=$(printf '%s' "$VEH2" | firstSpendId)
[ -n "$SPEND_ID2" ] || fail "could not read remaining spend id"
PATCHCODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/inventory/$VEHICLE_ID/spends/$SPEND_ID2" -H "$H_AUTH" -H "$H_JSON" -d '{"amount":450}')
echo "http=$PATCHCODE (expect 200)"; [ "$PATCHCODE" = "200" ] || fail "edit spend expected 200, got $PATCHCODE"
sleep 1
SP3=$(curl -s -H "$H_AUTH" "$API/accounting/sales?limit=100" | saleSpendForVehicle "$VEHICLE_ID")
echo "sale.totalSpend after edit = $SP3 (expect 450)"
[ "$SP3" = "450" ] || fail "expected re-synced Sale.totalSpend=450, got $SP3"

log "ALL SPEND CHECKS PASSED"
echo "vehicle_id=$VEHICLE_ID lead_id=$LEAD_ID buyer_id=$BUYER_ID"
