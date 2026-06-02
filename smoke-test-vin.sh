#!/bin/bash
# Smoke test: server-side NHTSA vPIC VIN decode (single + batch/bulk) + VIN uniqueness.
#
#   1. Decode a Nissan VIN and a Tesla VIN via GET /inventory/vin/:vin/decode
#   2. Reject a malformed VIN (400)
#   3. VIN uniqueness: create a vehicle with a VIN; a 2nd create with the SAME
#      VIN → 409; soft-delete it, then the same VIN can be added again → 201
#   4. Bulk upload: a VIN-only row decodes & creates, a manual row creates, and a
#      duplicate-VIN-in-file row is skipped
#
# Run while the backend is up.  Uses the shared smoke login.
# VINs are real North-American VINs (decode via NHTSA covers US + Canada).
set -e

API="http://localhost:3000/api/v1"
EMAIL="smoketest@cdms.local"
PASSWORD="SmokeTest1!"
NISSAN="5N1AT2MV8GC776183"   # 2016 Nissan Rogue
TESLA="7SAYGDEE9PF626297"    # 2023 Tesla Model Y
HONDA_CO="SmokeBulkHonda"    # unique marker so cleanup can find the manual bulk row

log()  { printf '\n=== %s ===\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

# Field extractor: jget <field> [dotted-path]  ("." = top-level envelope)
jget() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const path=process.argv[1]==="."?[]:process.argv[1].split(".");const key=process.argv[2];let cur=j;for(const p of path)cur=cur?.[p];const v=cur?.[key];if(v==null)process.exit(0);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v));}catch(e){}})' "${2:-data}" "$1"
}

log "Login"
TOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jget accessToken data)
[ -n "$TOKEN" ] || fail "no accessToken (is the backend up? is the smoke user seeded?)"
H_AUTH="Authorization: Bearer $TOKEN"
H_JSON="Content-Type: application/json"
echo "token len=${#TOKEN}"

# Delete any non-deleted test vehicles so the run is repeatable (by VIN or marker).
cleanup() {
  local ids
  ids=$(curl -s "$API/inventory?limit=200" -H "$H_AUTH" | node -e '
    let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{
      const j=JSON.parse(s);const list=j.data?.data||j.data||[];
      const vins=["'"$NISSAN"'","'"$TESLA"'"];
      for(const v of list){const vin=String(v.vin||"").toUpperCase();
        if(vins.includes(vin)||v.company==="'"$HONDA_CO"'")console.log(v._id);}
    }catch(e){}})')
  for id in $ids; do curl -s -X DELETE "$API/inventory/$id" -H "$H_AUTH" >/dev/null; done
}
log "Pre-clean leftover test vehicles"
cleanup; echo "cleaned"

log "1. Decode Nissan VIN ($NISSAN)"
R=$(curl -s "$API/inventory/vin/$NISSAN/decode" -H "$H_AUTH")
[ "$(printf '%s' "$R" | jget make data)" = "Nissan" ]        || fail "Nissan make: $R"
[ "$(printf '%s' "$R" | jget model data)" = "Rogue" ]        || fail "Nissan model: $R"
[ "$(printf '%s' "$R" | jget bodyType data)" = "Crossover" ] || fail "Nissan bodyType (want normalized 'Crossover'): $R"
pass "Nissan → $(printf '%s' "$R" | jget title data)"

log "2. Decode Tesla VIN ($TESLA)"
R=$(curl -s "$API/inventory/vin/$TESLA/decode" -H "$H_AUTH")
[ "$(printf '%s' "$R" | jget make data)" = "Tesla" ]    || fail "Tesla make: $R"
[ "$(printf '%s' "$R" | jget fuel data)" = "Electric" ] || fail "Tesla fuel: $R"
[ "$(printf '%s' "$R" | jget bodyType data)" = "SUV" ]  || fail "Tesla bodyType (want normalized 'SUV'): $R"
pass "Tesla → $(printf '%s' "$R" | jget title data)"

log "3. Reject malformed VIN"
R=$(curl -s "$API/inventory/vin/INVALID123/decode" -H "$H_AUTH")
SC=$(printf '%s' "$R" | jget statusCode .)
[ "$SC" = "400" ] || fail "expected 400 for malformed VIN, got statusCode=$SC: $R"
pass "malformed VIN rejected (400)"

log "4a. Create vehicle with Nissan VIN → 201"
R=$(curl -s -X POST "$API/inventory" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"title\":\"Smoke Nissan\",\"company\":\"Nissan\",\"model\":\"Rogue\",\"year\":2016,\"price\":18500,\"vin\":\"$NISSAN\"}")
VID=$(printf '%s' "$R" | jget _id data)
[ -n "$VID" ] || fail "create with VIN failed: $R"
pass "created vehicle id=$VID"

log "4b. Second create with the SAME VIN → expect 409"
R=$(curl -s -X POST "$API/inventory" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"title\":\"Dup Nissan\",\"company\":\"Nissan\",\"model\":\"Rogue\",\"year\":2016,\"price\":17000,\"vin\":\"$NISSAN\"}")
SC=$(printf '%s' "$R" | jget statusCode .)
[ "$SC" = "409" ] || fail "expected 409 for duplicate VIN, got statusCode=$SC: $R"
pass "duplicate VIN blocked (409)"

log "4c. Soft-delete it, then re-add the SAME VIN → expect 201"
curl -s -X DELETE "$API/inventory/$VID" -H "$H_AUTH" >/dev/null
R=$(curl -s -X POST "$API/inventory" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"title\":\"Re-add Nissan\",\"company\":\"Nissan\",\"model\":\"Rogue\",\"year\":2016,\"price\":17500,\"vin\":\"$NISSAN\"}")
VID2=$(printf '%s' "$R" | jget _id data)
[ -n "$VID2" ] || fail "re-add after delete failed (should be allowed): $R"
pass "re-add after delete OK (new id=$VID2)"

log "5. Bulk upload: VIN-only decode + manual row + duplicate-in-file skip"
# Clean the Nissan we just made so it doesn't interfere; bulk uses Tesla + manual.
cleanup
CSV="./_smoke-vin.csv"
printf '%s\n' \
"title,company,model,trim,year,engine,fuelType,transmission,bodyType,vin,km,price,discount,owners,color,hosting,description" \
",,,,,,,,,$TESLA,15000,51900,,1,White,self,VIN-only Tesla (specs auto-filled)" \
"\"${HONDA_CO} Civic\",${HONDA_CO},Civic,EX,2024,2.0L,petrol,automatic,Sedan,,5000,28000,,1,Silver,platform,Manual row no VIN" \
",,,,,,,,,$TESLA,9000,49000,,1,Black,self,Duplicate VIN in same file" \
> "$CSV"

R=$(curl -s -X POST "$API/inventory/bulk-upload" -H "$H_AUTH" -F "file=@$CSV;type=text/csv")
rm -f "$CSV"
CREATED=$(printf '%s' "$R" | jget created data); CREATED=${CREATED:-0}
DECODED=$(printf '%s' "$R" | jget decoded data); DECODED=${DECODED:-0}
ERRS=$(printf '%s' "$R" | jget errors data)
[ "$CREATED" = "2" ]      || fail "bulk: expected created=2 (Tesla + manual), got $CREATED. full: $R"
[ "$DECODED" -ge 1 ]      || fail "bulk: expected decoded>=1 (Tesla from VIN), got $DECODED. full: $R"
printf '%s' "$ERRS" | grep -qi "duplicate VIN" || fail "bulk: expected a duplicate-VIN skip in errors, got: $ERRS"
pass "bulk: created=$CREATED · decoded=$DECODED · errors=$ERRS"

log "Cleanup"
cleanup; echo "cleaned"

printf '\n✅ ALL VIN SMOKE TESTS PASSED\n'
