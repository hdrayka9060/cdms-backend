#!/bin/bash
# Smoke test: staff messaging (Phase 1 — REST core).
#   • DM create (idempotent) + send (text + file) + unread + mark-read
#   • own-chats-only: a non-participant (admin) is 403 on someone else's chat
#   • edit/delete own message; another user editing it → 403
#   • group create / add / update description / remove member
#   • staff-removal cascade: deleting a user marks them "left" in shared chats
#
# Run while the backend is up. Creates throwaway users (unique emails per run).
set -e

API="http://localhost:3000/api/v1"
ADMIN_EMAIL="smoketest@cdms.local"; ADMIN_PW="SmokeTest1!"
TS=$(date +%s); PW="ChatTest1!"

log(){ printf '\n=== %s ===\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass(){ printf 'PASS: %s\n' "$1"; }
jget(){ node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const path=process.argv[1]==="."?[]:process.argv[1].split(".");const key=process.argv[2];let cur=j;for(const p of path)cur=cur?.[p];const v=cur?.[key];if(v==null)process.exit(0);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v));}catch(e){}})' "${2:-data}" "$1"; }
authcode(){ curl -s -o /dev/null -w "%{http_code}" "$1" -H "Authorization: Bearer $2"; }

log "Admin login + Admin role id"
ATOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}" | jget accessToken data)
[ -n "$ATOKEN" ] || fail "admin login failed"
ROLE_ID=$(curl -s "$API/roles" -H "Authorization: Bearer $ATOKEN" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const list=j.data?.data||j.data||[];const admin=list.find(r=>r.name==="Admin")||list[0];if(admin)process.stdout.write(String(admin._id));}catch(e){}})')
[ -n "$ROLE_ID" ] || fail "no role id"

mkuser(){ # $1=label → echoes "id token"
  local email="chat_$1_${TS}@cdms.local"
  local id=$(curl -s -X POST "$API/users" -H "Authorization: Bearer $ATOKEN" -H "Content-Type: application/json" -d "{\"firstName\":\"$1\",\"lastName\":\"Chat\",\"email\":\"$email\",\"password\":\"$PW\",\"roleId\":\"$ROLE_ID\"}" | jget _id data)
  local tok=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$email\",\"password\":\"$PW\"}" | jget accessToken data)
  echo "$id $tok"
}

log "Create 3 staff (Alice, Bob, Carol)"
read AID ATOK < <(mkuser Alice); [ -n "$AID" ] && [ -n "$ATOK" ] || fail "Alice"
read BID BTOK < <(mkuser Bob);   [ -n "$BID" ] && [ -n "$BTOK" ] || fail "Bob"
read CID CTOK < <(mkuser Carol); [ -n "$CID" ] && [ -n "$CTOK" ] || fail "Carol"
pass "Alice=$AID Bob=$BID Carol=$CID"

log "Alice opens a DM with Bob"
CONV=$(curl -s -X POST "$API/messaging/conversations" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d "{\"type\":\"direct\",\"participantIds\":[\"$BID\"]}" | jget _id data)
[ -n "$CONV" ] || fail "DM create"
# idempotent: opening again returns the SAME conversation
CONV2=$(curl -s -X POST "$API/messaging/conversations" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d "{\"type\":\"direct\",\"participantIds\":[\"$BID\"]}" | jget _id data)
[ "$CONV" = "$CONV2" ] || fail "DM not idempotent ($CONV vs $CONV2)"
pass "DM=$CONV (idempotent)"

log "Alice sends a text message"
MSG=$(curl -s -X POST "$API/messaging/conversations/$CONV/messages" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d '{"body":"Hey Bob!"}' | jget _id data)
[ -n "$MSG" ] || fail "send text"
pass "message=$MSG"

log "Alice sends a file attachment"
echo "attachment body" > _smoke-msg.txt
ACOUNT=$(curl -s -X POST "$API/messaging/conversations/$CONV/messages" -H "Authorization: Bearer $ATOK" -F "files=@_smoke-msg.txt;type=text/plain" -F "body=here is a file" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{console.log((JSON.parse(s).data.attachments||[]).length)}catch{console.log(0)}})')
rm -f _smoke-msg.txt
[ "$ACOUNT" = "1" ] || fail "attachment not stored (count=$ACOUNT)"
pass "file message stored (attachments=$ACOUNT)"

log "Bob sees the DM with unread count"
UNREAD=$(curl -s "$API/messaging/conversations" -H "Authorization: Bearer $BTOK" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s).data||[];const c=j.find(x=>x._id==="'"$CONV"'");process.stdout.write(String(c?c.unreadCount:-1))}catch{process.stdout.write("-1")}})')
[ "$UNREAD" = "2" ] || fail "expected Bob unread=2, got $UNREAD"
pass "Bob unread=$UNREAD"

log "Own-chats-only: admin (non-participant) is blocked"
SC=$(authcode "$API/messaging/conversations/$CONV" "$ATOKEN")
[ "$SC" = "403" ] || fail "expected 403 for non-participant admin, got $SC"
pass "non-participant blocked ($SC)"

log "Bob reads + marks read → unread clears"
curl -s -o /dev/null "$API/messaging/conversations/$CONV/messages" -H "Authorization: Bearer $BTOK"
curl -s -o /dev/null -X PATCH "$API/messaging/conversations/$CONV/read" -H "Authorization: Bearer $BTOK"
UNREAD=$(curl -s "$API/messaging/conversations" -H "Authorization: Bearer $BTOK" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s).data||[];const c=j.find(x=>x._id==="'"$CONV"'");process.stdout.write(String(c?c.unreadCount:-1))}catch{process.stdout.write("-1")}})')
[ "$UNREAD" = "0" ] || fail "expected Bob unread=0 after read, got $UNREAD"
pass "unread cleared after read"

log "Alice edits her own message"
EDITED=$(curl -s -X PATCH "$API/messaging/conversations/$CONV/messages/$MSG" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d '{"body":"Hey Bob (edited)!"}' | jget isEdited data)
[ "$EDITED" = "true" ] || fail "edit failed (isEdited=$EDITED)"
pass "message edited"

log "Bob CANNOT edit Alice's message → 403"
SC=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/messaging/conversations/$CONV/messages/$MSG" -H "Authorization: Bearer $BTOK" -H "Content-Type: application/json" -d '{"body":"hijack"}')
[ "$SC" = "403" ] || fail "expected 403 editing another's message, got $SC"
pass "cross-user edit blocked ($SC)"

log "Alice deletes her own message (tombstone)"
DEL=$(curl -s -X DELETE "$API/messaging/conversations/$CONV/messages/$MSG" -H "Authorization: Bearer $ATOK" | jget isDeleted data)
[ "$DEL" = "true" ] || fail "delete failed (isDeleted=$DEL)"
pass "message soft-deleted"

log "Alice creates a group with Bob (+ description)"
GRP=$(curl -s -X POST "$API/messaging/conversations" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d "{\"type\":\"group\",\"name\":\"Sales Team\",\"description\":\"Q3 deals\",\"participantIds\":[\"$BID\"]}" | jget _id data)
[ -n "$GRP" ] || fail "group create"
pass "group=$GRP"

log "Alice adds Carol, updates description, then removes Carol"
curl -s -o /dev/null -X POST "$API/messaging/conversations/$GRP/participants" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d "{\"userIds\":[\"$CID\"]}"
NMEM=$(curl -s "$API/messaging/conversations/$GRP" -H "Authorization: Bearer $ATOK" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const p=(JSON.parse(s).data.participants||[]).filter(x=>!x.hasLeft);process.stdout.write(String(p.length))}catch{process.stdout.write("0")}})')
[ "$NMEM" = "3" ] || fail "expected 3 active members after add, got $NMEM"
DESC=$(curl -s -X PATCH "$API/messaging/conversations/$GRP" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d '{"description":"Updated desc"}' | jget description data)
[ "$DESC" = "Updated desc" ] || fail "group desc update (got '$DESC')"
curl -s -o /dev/null -X DELETE "$API/messaging/conversations/$GRP/participants/$CID" -H "Authorization: Bearer $ATOK"
pass "added/updated/removed (3 members, desc updated)"

log "Group system messages (created / added / removed)"
GMSGS=$(curl -s "$API/messaging/conversations/$GRP/messages" -H "Authorization: Bearer $ATOK")
printf '%s' "$GMSGS" | grep -q "created the group" || fail "missing 'created the group' system message"
printf '%s' "$GMSGS" | grep -q "added Carol"       || fail "missing 'added' system message"
printf '%s' "$GMSGS" | grep -q "removed Carol"     || fail "missing 'removed' system message"
# system messages are non-editable
SMID=$(printf '%s' "$GMSGS" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const a=JSON.parse(s).data||[];const m=a.find(x=>x.isSystem);process.stdout.write(m?m._id:"")}catch(e){}})')
SC=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/messaging/conversations/$GRP/messages/$SMID" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d '{"body":"hack"}')
[ "$SC" = "403" ] || fail "system message should not be editable, got $SC"
pass "system messages present + non-editable (403)"

log "Self-leave posts a 'left the group' system message"
# Carol rejoins, then leaves herself.
curl -s -o /dev/null -X POST "$API/messaging/conversations/$GRP/participants" -H "Authorization: Bearer $ATOK" -H "Content-Type: application/json" -d "{\"userIds\":[\"$CID\"]}"
curl -s -o /dev/null -X DELETE "$API/messaging/conversations/$GRP/participants/$CID" -H "Authorization: Bearer $CTOK"
printf '%s' "$(curl -s "$API/messaging/conversations/$GRP/messages" -H "Authorization: Bearer $ATOK")" | grep -q "left the group" || fail "missing 'left the group' system message"
pass "self-leave system message present"

log "Staff-removal cascade: delete Bob → 'user left' in Alice's DM + group"
curl -s -o /dev/null -X DELETE "$API/users/$BID" -H "Authorization: Bearer $ATOKEN"
LEFT=$(curl -s "$API/messaging/conversations/$CONV" -H "Authorization: Bearer $ATOK" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const p=(JSON.parse(s).data.participants||[]).find(x=>x.userId==="'"$BID"'");process.stdout.write(String(p?p.hasLeft:"missing"))}catch{process.stdout.write("err")}})')
[ "$LEFT" = "true" ] || fail "expected Bob hasLeft=true in DM after removal, got $LEFT"
# Alice still sees the DM (she's an active participant)
SC=$(authcode "$API/messaging/conversations/$CONV" "$ATOK")
[ "$SC" = "200" ] || fail "Alice should still access the DM, got $SC"
pass "Bob shows as 'user left'; Alice retains access"

log "Cleanup"
for id in "$AID" "$CID"; do curl -s -o /dev/null -X DELETE "$API/users/$id" -H "Authorization: Bearer $ATOKEN"; done
echo "cleaned"

printf '\n✅ ALL MESSAGING SMOKE TESTS PASSED\n'
