#!/bin/bash
# Smoke test: group permission/membership model.
#   • any member (not just admin) can add staff
#   • admin can promote a member to admin
#   • history visibility is frozen at join (ON-joiner keeps history after toggle OFF;
#     OFF-joiner never sees pre-join messages)
#   • sole admin can't leave while others remain (must hand off admin first)
#   • last member leaving deletes the group
set -e

API="http://localhost:3000/api/v1"
ADMIN_EMAIL="smoketest@cdms.local"; ADMIN_PW="SmokeTest1!"
TS=$(date +%s); PW="GrpPerm1!"

log(){ printf '\n=== %s ===\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass(){ printf 'PASS: %s\n' "$1"; }
jget(){ node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const p=process.argv[1]==="."?[]:process.argv[1].split(".");const k=process.argv[2];let c=j;for(const x of p)c=c?.[x];const v=c?.[k];if(v==null)process.exit(0);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))}catch(e){}})' "${2:-data}" "$1"; }
# active-member count of a conversation response
nmem(){ node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const p=(JSON.parse(s).data.participants||[]).filter(x=>!x.hasLeft);process.stdout.write(String(p.length))}catch{process.stdout.write("0")}})'; }
# role of a given userId in a conversation response
roleof(){ node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const p=(JSON.parse(s).data.participants||[]).find(x=>x.userId==="'"$1"'");process.stdout.write(p?p.role:"none")}catch{process.stdout.write("err")}})'; }

log "Admin login + Admin role"
AT=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}" | jget accessToken data)
[ -n "$AT" ] || fail "admin login"
RID=$(curl -s "$API/roles" -H "Authorization: Bearer $AT" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const l=JSON.parse(s).data?.data||JSON.parse(s).data||[];process.stdout.write((l.find(r=>r.name==="Admin")||l[0])._id)}catch(e){}})')
[ -n "$RID" ] || fail "role id"

mkuser(){ local email="gp_$1_${TS}@cdms.local"
  local id=$(curl -s -X POST "$API/users" -H "Authorization: Bearer $AT" -H "Content-Type: application/json" -d "{\"firstName\":\"$1\",\"lastName\":\"GP\",\"email\":\"$email\",\"password\":\"$PW\",\"roleId\":\"$RID\"}" | jget _id data)
  local tok=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$email\",\"password\":\"$PW\"}" | jget accessToken data)
  echo "$id $tok"; }

log "Create Alice, Bob, Carol, Dave"
read AID ATOK < <(mkuser Alice); read BID BTOK < <(mkuser Bob); read CID CTOK < <(mkuser Carol); read DID DTOK < <(mkuser Dave)
[ -n "$AID$BID$CID$DID" ] || fail "user creation"
pass "A=$AID B=$BID C=$CID D=$DID"

log "Self-DM (Notes to self)"
SELF=$(curl -s -X POST "$API/messaging/conversations" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d "{\"type\":\"direct\",\"participantIds\":[\"$AID\"]}" | jget _id data)
[ -n "$SELF" ] || fail "self-DM create"
SELF2=$(curl -s -X POST "$API/messaging/conversations" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d "{\"type\":\"direct\",\"participantIds\":[\"$AID\"]}" | jget _id data)
[ "$SELF" = "$SELF2" ] || fail "self-DM not idempotent ($SELF vs $SELF2)"
curl -s -o /dev/null -X POST "$API/messaging/conversations/$SELF/messages" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d '{"body":"note to self"}'
printf '%s' "$(curl -s "$API/messaging/conversations/$SELF/messages" -H "Authorization: Bearer $ATOK")" | grep -q "note to self" || fail "self message not stored"
U=$(curl -s "$API/messaging/conversations" -H "Authorization: Bearer $ATOK" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const c=(JSON.parse(s).data||[]).find(x=>x._id==="'"$SELF"'");process.stdout.write(String(c?c.unreadCount:-1))}catch{process.stdout.write("-1")}})')
[ "$U" = "0" ] || fail "self chat unread should be 0, got $U"
pass "self-DM works (idempotent, send, unread=0)"

log "Alice creates group with Bob (history sharing ON by default)"
GRP=$(curl -s -X POST "$API/messaging/conversations" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d "{\"type\":\"group\",\"name\":\"Perm Test\",\"participantIds\":[\"$BID\"]}" | jget _id data)
[ -n "$GRP" ] || fail "group create"
curl -s -o /dev/null -X POST "$API/messaging/conversations/$GRP/messages" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d '{"body":"history-msg-1"}'
pass "group=$GRP, sent history-msg-1"

log "Non-admin (Bob) adds Carol"
R=$(curl -s -X POST "$API/messaging/conversations/$GRP/participants" -H "Authorization: Bearer $BTOK" -H "Content-Type: application/json" -d "{\"userIds\":[\"$CID\"]}")
[ "$(printf '%s' "$R" | nmem)" = "3" ] || fail "Bob (member) could not add Carol: $R"
pass "any member can add (Bob added Carol → 3 members)"

log "History ON → Carol sees pre-join message"
printf '%s' "$(curl -s "$API/messaging/conversations/$GRP/messages" -H "Authorization: Bearer $CTOK")" | grep -q "history-msg-1" || fail "Carol should see history-msg-1"
pass "Carol (joined while ON) sees prior history"

log "Alice turns history sharing OFF, sends history-msg-2, Bob adds Dave"
curl -s -o /dev/null -X PATCH "$API/messaging/conversations/$GRP" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d '{"shareHistoryWithNewMembers":false}'
curl -s -o /dev/null -X POST "$API/messaging/conversations/$GRP/messages" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d '{"body":"history-msg-2"}'
curl -s -o /dev/null -X POST "$API/messaging/conversations/$GRP/participants" -H "Authorization: Bearer $BTOK" -H "Content-Type: application/json" -d "{\"userIds\":[\"$DID\"]}"
pass "sharing OFF, history-msg-2 sent, Dave added"

log "History OFF → Dave cannot see pre-join messages"
DMSGS=$(curl -s "$API/messaging/conversations/$GRP/messages" -H "Authorization: Bearer $DTOK")
printf '%s' "$DMSGS" | grep -q "history-msg-1" && fail "Dave should NOT see history-msg-1: $DMSGS"
printf '%s' "$DMSGS" | grep -q "history-msg-2" && fail "Dave should NOT see history-msg-2"
pass "Dave (joined while OFF) sees no pre-join history"

log "Carol RETAINS full history after toggle OFF (frozen at join)"
printf '%s' "$(curl -s "$API/messaging/conversations/$GRP/messages" -H "Authorization: Bearer $CTOK")" | grep -q "history-msg-1" || fail "Carol must retain history after toggle"
pass "Carol still sees history-msg-1 (join-time capture honored)"

log "Admin promotes Bob to admin"
R=$(curl -s -X PATCH "$API/messaging/conversations/$GRP/participants/$BID/role" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d '{"role":"admin"}')
[ "$(printf '%s' "$R" | roleof "$BID")" = "admin" ] || fail "Bob not promoted: $R"
printf '%s' "$(curl -s "$API/messaging/conversations/$GRP/messages" -H "Authorization: Bearer $ATOK")" | grep -q "made Bob GP an admin" || fail "no promote system message"
pass "Bob promoted to admin (+ system message)"

log "Sole-admin leave is blocked while others remain"
GRP2=$(curl -s -X POST "$API/messaging/conversations" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d "{\"type\":\"group\",\"name\":\"Solo Admin\",\"participantIds\":[\"$CID\"]}" | jget _id data)
SC=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/messaging/conversations/$GRP2/participants/$AID" -H "Authorization: Bearer $ATOK")
[ "$SC" = "400" ] || fail "sole admin leave should be 400, got $SC"
pass "sole admin blocked from leaving (400)"

log "Last member leaving deletes the group"
curl -s -o /dev/null -X DELETE "$API/messaging/conversations/$GRP2/participants/$CID" -H "Authorization: Bearer $ATOK"  # admin removes Carol → Alice alone
curl -s -o /dev/null -X DELETE "$API/messaging/conversations/$GRP2/participants/$AID" -H "Authorization: Bearer $ATOK"  # Alice (last) leaves → delete
SC=$(curl -s -o /dev/null -w "%{http_code}" "$API/messaging/conversations/$GRP2" -H "Authorization: Bearer $ATOK")
[ "$SC" = "404" ] || fail "group should be deleted (404), got $SC"
pass "last member left → group deleted (404)"

log "Cleanup"
for id in "$AID" "$BID" "$CID" "$DID"; do curl -s -o /dev/null -X DELETE "$API/users/$id" -H "Authorization: Bearer $AT"; done
echo "cleaned"
printf '\n✅ ALL GROUP-PERMISSION SMOKE TESTS PASSED\n'
