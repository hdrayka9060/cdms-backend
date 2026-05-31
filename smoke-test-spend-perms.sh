#!/bin/bash
# Verifies the spend-permission contract:
#   - Adding/editing a spend requires Inventory:EDIT
#   - DELETING a spend requires Inventory:DELETE  (the bug fix)
#
# An Inventory view+edit (no delete) user must be able to ADD a spend but must
# be BLOCKED (403) from deleting one. A delete-capable user (admin) can delete.
#
# Creates a throwaway role + user (timestamped names so re-runs don't 409).

set -e
API="http://localhost:3000/api/v1"
ADMIN_EMAIL="smoketest@cdms.local"; ADMIN_PASS="SmokeTest1!"
TS=$(date +%s)

log() { printf '\n=== %s ===\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
jget() {
  local key="$1"; local path="${2:-data}"
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const path=process.argv[1]==="."?[]:process.argv[1].split(".");const key=process.argv[2];let cur=j;for(const p of path)cur=cur?.[p];const v=cur?.[key];if(v==null)process.exit(0);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v));}catch(e){}});' "$path" "$key"
}
firstSpendId() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const sp=(j?.data?.spends||[])[0];process.stdout.write(sp?String(sp._id):"");}catch(e){}});'
}

log "Admin login"
ADMIN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jget accessToken data)
[ -n "$ADMIN" ] || fail "no admin token"
AH="Authorization: Bearer $ADMIN"; JSON="Content-Type: application/json"
echo "ok"

log "Create Inventory view+edit (NO delete) role"
ROLE_ID=$(curl -s -X POST "$API/roles" -H "$AH" -H "$JSON" -d "{\"name\":\"SpendEditOnly $TS\",\"description\":\"test\",\"permissions\":[{\"module\":\"Inventory\",\"actions\":[\"view\",\"edit\"]},{\"module\":\"Dashboard\",\"actions\":[\"view\"]}]}" | jget _id data)
[ -n "$ROLE_ID" ] || fail "role not created"
echo "role=$ROLE_ID"

log "Create user with that role"
UEMAIL="spendedit.$TS@cdms.local"; UPASS="EditOnly1!"
CREATE=$(curl -s -X POST "$API/users" -H "$AH" -H "$JSON" -d "{\"firstName\":\"Spend\",\"lastName\":\"EditOnly\",\"email\":\"$UEMAIL\",\"password\":\"$UPASS\",\"roleId\":\"$ROLE_ID\"}")
NEW_UID=$(printf '%s' "$CREATE" | jget _id data)
[ -n "$NEW_UID" ] || fail "user not created — $CREATE"
echo "user=$NEW_UID"

log "Login as edit-only user"
UTOKEN=$(curl -s -X POST "$API/auth/login" -H "$JSON" -d "{\"email\":\"$UEMAIL\",\"password\":\"$UPASS\"}" | jget accessToken data)
[ -n "$UTOKEN" ] || fail "edit-only user could not log in"
UH="Authorization: Bearer $UTOKEN"
echo "ok"

log "Edit-only user creates a vehicle (Inventory:edit) → expect a vehicle id"
VEH=$(curl -s -X POST "$API/inventory" -H "$UH" -H "$JSON" -d '{"title":"PermTest Car","company":"Test","model":"Perm","year":2022,"price":10000,"costPrice":8000,"status":"unsold"}' | jget _id data)
[ -n "$VEH" ] || fail "edit-only user could not create vehicle (edit should work)"
echo "vehicle=$VEH"

log "Edit-only user ADDS a spend → expect 201 (edit allowed)"
ADD=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/inventory/$VEH/spends" -H "$UH" -H "$JSON" -d '{"amount":200,"category":"Repair"}')
echo "http=$ADD (expect 201)"; [ "$ADD" = "201" ] || fail "edit-only ADD spend expected 201, got $ADD"

SPEND_ID=$(curl -s -H "$UH" "$API/inventory/$VEH" | firstSpendId)
[ -n "$SPEND_ID" ] || fail "could not read spend id"
echo "spend=$SPEND_ID"

log "Edit-only user DELETES the spend → expect 403 (delete NOT allowed) ← THE FIX"
DEL=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/inventory/$VEH/spends/$SPEND_ID" -H "$UH")
echo "http=$DEL (expect 403)"; [ "$DEL" = "403" ] || fail "edit-only user was able to delete spend (got $DEL, expected 403) — BUG NOT FIXED"

log "Admin (has delete) DELETES the spend → expect 200"
DELA=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/inventory/$VEH/spends/$SPEND_ID" -H "$AH")
echo "http=$DELA (expect 200)"; [ "$DELA" = "200" ] || fail "admin delete spend expected 200, got $DELA"

log "Cleanup (best-effort)"
curl -s -o /dev/null -X DELETE "$API/inventory/$VEH" -H "$AH" || true
curl -s -o /dev/null -X DELETE "$API/users/$NEW_UID" -H "$AH" || true
curl -s -o /dev/null -X DELETE "$API/roles/$ROLE_ID" -H "$AH" || true

log "SPEND PERMISSION CHECKS PASSED"
echo "edit-only user can add (201) but cannot delete (403); delete-capable can delete (200)"
