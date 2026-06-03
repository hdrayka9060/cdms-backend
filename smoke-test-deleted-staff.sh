#!/bin/bash
# Security smoke test: a removed (soft-deleted) staff member can NO LONGER
#   (a) use their already-issued access token on any API call,
#   (b) log in,
#   (c) mint a fresh token via /auth/refresh.
#
# Identity is re-checked against the DB on every request (JwtStrategy.validate
# → usersService.findById, which filters { isDeleted: false } and throws), so a
# deleted user is locked out immediately — no grace window until token expiry.
#
# Run while the backend is up.  Uses the shared smoke admin login.
set -e

API="http://localhost:3000/api/v1"
ADMIN_EMAIL="smoketest@cdms.local"
ADMIN_PW="SmokeTest1!"
TS=$(date +%s)
NEW_EMAIL="deltest+${TS}@cdms.local"
NEW_PW="DelTest1!"

log()  { printf '\n=== %s ===\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

jget() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const path=process.argv[1]==="."?[]:process.argv[1].split(".");const key=process.argv[2];let cur=j;for(const p of path)cur=cur?.[p];const v=cur?.[key];if(v==null)process.exit(0);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v));}catch(e){}})' "${2:-data}" "$1"
}

# HTTP status of an authenticated GET
auth_status() { curl -s -o /dev/null -w "%{http_code}" "$1" -H "Authorization: Bearer $2"; }
# "blocked" = any 4xx auth/identity rejection (401/403/404 are all "can't access")
is_blocked() { [ "$1" -ge 401 ] && [ "$1" -le 404 ]; }

log "Admin login"
ATOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}" | jget accessToken data)
[ -n "$ATOKEN" ] || fail "admin login failed (backend up? smoke user seeded?)"

log "Pick a role for the throwaway user"
ROLE_ID=$(curl -s "$API/roles" -H "Authorization: Bearer $ATOKEN" | node -e '
  let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{
    const j=JSON.parse(s);const list=j.data?.data||j.data||[];
    if(list[0]?._id)process.stdout.write(String(list[0]._id));
  }catch(e){}})')
[ -n "$ROLE_ID" ] || fail "could not read a role id from /roles"

log "Admin creates a throwaway staff user ($NEW_EMAIL)"
NEW_UID=$(curl -s -X POST "$API/users" -H "Authorization: Bearer $ATOKEN" -H "Content-Type: application/json" \
  -d "{\"firstName\":\"Del\",\"lastName\":\"Test\",\"email\":\"$NEW_EMAIL\",\"password\":\"$NEW_PW\",\"roleId\":\"$ROLE_ID\"}" | jget _id data)
[ -n "$NEW_UID" ] || fail "create user failed"
pass "created user id=$NEW_UID"

log "Throwaway user logs in (pre-delete)"
ULOGIN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$NEW_EMAIL\",\"password\":\"$NEW_PW\"}")
UTOKEN=$(printf '%s' "$ULOGIN" | jget accessToken data)
UREFRESH=$(printf '%s' "$ULOGIN" | jget refreshToken data)
[ -n "$UTOKEN" ] || fail "new user login failed: $ULOGIN"
pass "new user logged in (has a valid access + refresh token)"

log "Token works BEFORE delete"
SC=$(auth_status "$API/users/me" "$UTOKEN")
[ "$SC" = "200" ] || fail "expected 200 on /users/me before delete, got $SC"
pass "GET /users/me → 200 (token valid before delete)"

log "Admin removes the user (soft delete)"
curl -s -X DELETE "$API/users/$NEW_UID" -H "Authorization: Bearer $ATOKEN" >/dev/null
pass "user removed"

log "Same access token AFTER delete → must be blocked"
SC=$(auth_status "$API/users/me" "$UTOKEN")
is_blocked "$SC" || fail "expected the existing token to be REJECTED after delete, got $SC (NOT blocked!)"
pass "GET /users/me → $SC (existing token rejected)"

SC=$(auth_status "$API/inventory" "$UTOKEN")
is_blocked "$SC" || fail "expected /inventory blocked after delete, got $SC"
pass "GET /inventory → $SC (existing token rejected on a second endpoint)"

log "Login after delete → must be blocked"
SC=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$NEW_EMAIL\",\"password\":\"$NEW_PW\"}")
[ "$SC" = "401" ] || fail "expected 401 login after delete, got $SC"
pass "POST /auth/login → 401 (removed staff cannot log in)"

log "Refresh after delete → must be blocked"
SC=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/auth/refresh" -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$UREFRESH\"}")
[ "$SC" = "401" ] || fail "expected 401 refresh after delete, got $SC"
pass "POST /auth/refresh → 401 (cannot mint a new token)"

printf '\n✅ CONFIRMED: a removed staff member cannot log in, cannot use an existing token, and cannot refresh.\n'
