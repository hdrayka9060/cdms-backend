#!/bin/bash
# Smoke test for the Buyer Portal feature (Steps 1 + 2).
#
# Step 1 — calendar↔lead link:
#   * create an event with `lead` set → the lead's timeline gets a note
# Step 2 — public buyer portal (GET /website/portal/:id, NO auth):
#   * greeting first name, journey status, vehicle, offer (askedPrice)
#   * appointments = lead-linked calendar events
#   * communications = channel + date + summary
#   * sold-to-THIS-buyer → soldPrice shown
#   * sold-to-OTHER-buyer → "sold" with no price
#   * invalid id → 404
#
# Run while the backend is up.
set -e

API="http://localhost:3000/api/v1"
EMAIL="smoketest@cdms.local"
PASSWORD="SmokeTest1!"

log()  { printf '\n=== %s ===\n' "$1"; }
pass() { printf '  PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# Pull a value from the envelope by dotted path. Usage: echo "$JSON" | jget data.status
jget() {
  node -e '
    let s=""; process.stdin.on("data",c=>s+=c);
    process.stdin.on("end",()=>{ try{
      const j=JSON.parse(s);
      let cur=j; for(const p of (process.argv[1]?process.argv[1].split("."):[])) cur=cur?.[p];
      if(cur===undefined||cur===null){process.exit(0);}
      process.stdout.write(typeof cur==="object"?JSON.stringify(cur):String(cur));
    }catch(e){process.stdout.write("");} });
  ' "$1"
}

# Evaluate a JS expression against the parsed envelope `j`. Prints "true"/"false"/value.
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

iso() { node -e "console.log(new Date(Date.now()+($1)).toISOString())"; }

# ── Auth (login; register the smoke admin if missing) ────────────────────────
log "Login"
LOGIN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(printf '%s' "$LOGIN" | jget data.accessToken)
if [ -z "$TOKEN" ]; then
  echo "  login failed, attempting register (first user → admin)…"
  curl -s -X POST "$API/auth/register" -H "Content-Type: application/json" \
    -d "{\"firstName\":\"Smoke\",\"lastName\":\"Test\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
  LOGIN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
  TOKEN=$(printf '%s' "$LOGIN" | jget data.accessToken)
fi
[ -n "$TOKEN" ] || fail "no accessToken — login response: $LOGIN"
A="Authorization: Bearer $TOKEN"; J="Content-Type: application/json"
pass "token len=${#TOKEN}"

# ── Fixtures ─────────────────────────────────────────────────────────────────
log "Create buyer + vehicle + lead"
BUYER=$(curl -s -X POST "$API/crm/buyers" -H "$A" -H "$J" \
  -d '{"buyerName":"Portal Buyer","buyerEmail":"portal.buyer@example.com","buyerPhone":"+15555551234","budget":20000,"stage":"new"}')
BUYER_ID=$(printf '%s' "$BUYER" | jget data._id); [ -n "$BUYER_ID" ] || fail "no buyer id: $BUYER"
VEH=$(curl -s -X POST "$API/inventory" -H "$A" -H "$J" \
  -d '{"title":"Portal Car","company":"Test","model":"PX","year":2023,"price":18000,"costPrice":14000,"km":21000,"fuelType":"petrol","transmission":"automatic","status":"unsold"}')
VEH_ID=$(printf '%s' "$VEH" | jget data._id); [ -n "$VEH_ID" ] || fail "no vehicle id: $VEH"
LEAD=$(curl -s -X POST "$API/leads" -H "$A" -H "$J" \
  -d "{\"buyer\":\"$BUYER_ID\",\"vehicle\":\"$VEH_ID\",\"source\":\"website\",\"status\":\"new\",\"notes\":\"portal smoke\"}")
LEAD_ID=$(printf '%s' "$LEAD" | jget data._id); [ -n "$LEAD_ID" ] || fail "no lead id: $LEAD"
pass "buyer=$BUYER_ID vehicle=$VEH_ID lead=$LEAD_ID"

# ── STEP 1: calendar event linked to the lead → lead timeline note ───────────
log "STEP 1 — create calendar event linked to the lead"
EV=$(curl -s -X POST "$API/calendar/events" -H "$A" -H "$J" -d "{
  \"title\":\"Test Drive - Portal\",
  \"startDateTime\":\"$(iso 86400000)\",
  \"endDateTime\":\"$(iso 90000000)\",
  \"eventType\":\"test_drive\",
  \"meetingType\":\"physical\",
  \"location\":\"Showroom\",
  \"lead\":\"$LEAD_ID\",
  \"vehicle\":\"$VEH_ID\"
}")
EV_ID=$(printf '%s' "$EV" | jget data._id); [ -n "$EV_ID" ] || fail "no event id: $EV"
EV_LEAD=$(printf '%s' "$EV" | jget data.lead)
[ "$EV_LEAD" = "$LEAD_ID" ] || fail "event.lead not persisted (got '$EV_LEAD')"
pass "event=$EV_ID persisted with lead ref"

LEAD_DOC=$(curl -s -H "$A" "$API/leads/$LEAD_ID")
HAS_NOTE=$(printf '%s' "$LEAD_DOC" | jsx 'j.data.timeline.some(t=>String(t.action||"").toLowerCase().includes("scheduled"))')
[ "$HAS_NOTE" = "true" ] || fail "lead timeline has no 'scheduled' note: $(printf '%s' "$LEAD_DOC" | jget data.timeline)"
pass "lead timeline captured the event"

# ── STEP 2: public portal (NO auth header) ───────────────────────────────────
log "STEP 2 — GET /website/portal/:id (public)"
P=$(curl -s "$API/website/portal/$LEAD_ID")
[ "$(printf '%s' "$P" | jget data.buyer.firstName)" = "Portal" ] || fail "greeting firstName wrong: $P"
[ "$(printf '%s' "$P" | jget data.journeyStatus)" = "new" ] || fail "journeyStatus != new"
[ "$(printf '%s' "$P" | jget data.vehicle.title)" = "Portal Car" ] || fail "vehicle.title wrong"
[ "$(printf '%s' "$P" | jsx 'j.data.appointments.length>=1')" = "true" ] || fail "no appointments"
[ "$(printf '%s' "$P" | jsx 'j.data.appointments[0].type')" = "test_drive" ] || fail "appt type wrong"
[ "$(printf '%s' "$P" | jget data.sold.isSold)" = "false" ] || fail "sold should be false pre-sale"
[ "$(printf '%s' "$P" | jget data.offer)" = "" ] || fail "offer should be null pre-askedPrice"
[ -n "$(printf '%s' "$P" | jget data.browseUrl)" ] || fail "browseUrl missing"
pass "portal renders vehicle + appointment, no auth needed"

log "STEP 2 — askedPrice → Your Offer + negotiation"
curl -s -X PATCH "$API/leads/$LEAD_ID" -H "$A" -H "$J" -d '{"askedPrice":16500}' >/dev/null
P=$(curl -s "$API/website/portal/$LEAD_ID")
[ "$(printf '%s' "$P" | jget data.offer.askedPrice)" = "16500" ] || fail "offer.askedPrice wrong: $(printf '%s' "$P" | jget data.offer)"
[ "$(printf '%s' "$P" | jget data.journeyStatus)" = "negotiation" ] || fail "askedPrice should bump to negotiation"
pass "offer=16500, journey=negotiation"

log "STEP 2 — comms show channel + date + summary"
curl -s -X POST "$API/leads/$LEAD_ID/log" -H "$A" -H "$J" \
  -d '{"channel":"call","summary":"Called buyer re financing"}' >/dev/null
P=$(curl -s "$API/website/portal/$LEAD_ID")
[ "$(printf '%s' "$P" | jsx 'j.data.communications.length>=1')" = "true" ] || fail "no comms"
[ "$(printf '%s' "$P" | jsx 'j.data.communications[0].channel')" = "call" ] || fail "comm channel wrong"
[ "$(printf '%s' "$P" | jsx 'j.data.communications.some(c=>c.summary==="Called buyer re financing")')" = "true" ] || fail "comm summary missing"
pass "comms expose channel + date + summary"

# ── STEP 2: sold to THIS buyer ───────────────────────────────────────────────
log "STEP 2 — close lead (sold to THIS buyer) → soldPrice shown"
curl -s -X POST "$API/leads/$LEAD_ID/close" -H "$A" -H "$J" \
  -d '{"soldAt":16000,"paymentMethod":"cash","paymentStatus":"paid","amountPaid":16000}' >/dev/null
P=$(curl -s "$API/website/portal/$LEAD_ID")
[ "$(printf '%s' "$P" | jget data.sold.isSold)" = "true" ] || fail "sold.isSold should be true"
[ "$(printf '%s' "$P" | jget data.sold.soldToThisBuyer)" = "true" ] || fail "should be soldToThisBuyer"
[ "$(printf '%s' "$P" | jget data.sold.soldPrice)" = "16000" ] || fail "soldPrice wrong: $(printf '%s' "$P" | jget data.sold)"
pass "sold to this buyer, price=16000"

# ── STEP 2: sold to ANOTHER buyer ────────────────────────────────────────────
log "STEP 2 — vehicle sold to ANOTHER buyer → 'sold', no price"
BUYER2=$(curl -s -X POST "$API/crm/buyers" -H "$A" -H "$J" \
  -d '{"buyerName":"Second Buyer","buyerEmail":"second.buyer@example.com","buyerPhone":"+15555559999","budget":15000,"stage":"new"}')
BUYER2_ID=$(printf '%s' "$BUYER2" | jget data._id)
VEH2=$(curl -s -X POST "$API/inventory" -H "$A" -H "$J" \
  -d '{"title":"Portal Car 2","company":"Test","model":"PY","year":2022,"price":14000,"costPrice":11000,"km":33000,"fuelType":"petrol","transmission":"automatic","status":"unsold"}')
VEH2_ID=$(printf '%s' "$VEH2" | jget data._id)
LEAD2=$(curl -s -X POST "$API/leads" -H "$A" -H "$J" \
  -d "{\"buyer\":\"$BUYER2_ID\",\"vehicle\":\"$VEH2_ID\",\"source\":\"website\",\"status\":\"new\"}")
LEAD2_ID=$(printf '%s' "$LEAD2" | jget data._id)
# Record a sale on vehicle2 to a DIFFERENT person (not buyer2) → sibling-archives lead2.
curl -s -X POST "$API/accounting/sales" -H "$A" -H "$J" -d "{
  \"vehicleId\":\"$VEH2_ID\",\"vehicleTitle\":\"Portal Car 2\",
  \"buyerName\":\"Walk In\",\"buyerEmail\":\"walkin.other@example.com\",
  \"salePrice\":13500,\"saleDate\":\"$(iso 0)\",\"paymentMethod\":\"cash\",\"paymentStatus\":\"paid\"}" >/dev/null
sleep 1
P=$(curl -s "$API/website/portal/$LEAD2_ID")
[ "$(printf '%s' "$P" | jget data.sold.isSold)" = "true" ] || fail "veh2 should be sold"
[ "$(printf '%s' "$P" | jget data.sold.soldToThisBuyer)" = "false" ] || fail "should NOT be soldToThisBuyer"
[ "$(printf '%s' "$P" | jget data.sold.soldPrice)" = "" ] || fail "soldPrice should be hidden for other buyer"
pass "sold to other buyer → no price exposed"

# ── 404 ──────────────────────────────────────────────────────────────────────
log "STEP 2 — invalid lead id → 404"
P=$(curl -s "$API/website/portal/not-a-real-id")
[ "$(printf '%s' "$P" | jget statusCode)" = "404" ] || fail "expected 404, got: $P"
pass "invalid id → 404"

log "ALL CHECKS PASSED"
echo "lead=$LEAD_ID lead2=$LEAD2_ID vehicle=$VEH_ID vehicle2=$VEH2_ID event=$EV_ID"
