#!/bin/bash
# Real-mode smoke test for Facebook Listings (LIVE Graph API).
#
# Exercises the real path against the connected Page:
#   A. Text Page post  : publish -> assert active + fbPostId -> remove (deletes the FB post)
#   B. Photo Page post : upload image -> S3 public URL -> publish -> remove
#   C. Real Graph reads: sync-conversations, analytics, comments, conversations
#
# SIDE EFFECTS: briefly creates (then deletes) clearly-labelled test posts on the
# REAL Page. Requires the backend in REAL mode (FACEBOOK_* + S3_* configured) and
# a connected active Page. Uses the shared smoke login.
#
# Does NOT use `set -e`: every phase runs so ALL findings surface; exits non-zero
# if any check failed.

API="http://localhost:3000/api/v1"
EMAIL="smoketest@cdms.local"
PASSWORD="SmokeTest1!"
MARK="CDMSFBSMOKE"          # vehicle company marker (cleanup)
PNG="./_fb-smoke.png"
FAILS=0

log()   { printf '\n=== %s ===\n' "$1"; }
pass()  { printf '  PASS: %s\n' "$1"; }
ffail() { printf '  FAIL: %s\n' "$1"; FAILS=$((FAILS+1)); }
note()  { printf '  ... %s\n' "$1"; }

# Envelope field extractor: jget <field> [dotted-path]  ("." = top-level)
jget() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const path=process.argv[1]==="."?[]:process.argv[1].split(".");const key=process.argv[2];let cur=j;for(const p of path)cur=cur?.[p];const v=cur?.[key];if(v==null)process.exit(0);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v));}catch(e){}})' "${2:-data}" "$1"
}

# Pull status/fbPostId/_id from a createListings response (data[0]); echoes "id status fbPostId".
listing_fields() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const a=(j.data||[])[0]||{};process.stdout.write((a._id||"-")+" "+(a.status||"-")+" "+(a.fbPostId||"-"));}catch(e){process.stdout.write("- - -");}})'
}
listing_error() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const a=(j.data||[])[0]||{};process.stdout.write(a.lastError||(j.message?JSON.stringify(j.message):""));}catch(e){}})'
}

log "Login"
TOKEN=$(curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jget accessToken data)
if [ -z "$TOKEN" ]; then echo "FATAL: no accessToken (backend up? smoke user seeded?)"; exit 1; fi
H_AUTH="Authorization: Bearer $TOKEN"; H_JSON="Content-Type: application/json"
echo "  token len=${#TOKEN}"

log "Connected Pages"
CONNS=$(curl -s "$API/facebook/connections" -H "$H_AUTH")
read -r CONN_ID PAGE_NAME < <(printf '%s' "$CONNS" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const list=j.data||[];const a=list.find(c=>c.status==="active")||list[0];if(a)process.stdout.write(a._id+" "+String(a.pageName||"page").replace(/\s+/g,"_"));}catch(e){}})')
if [ -z "$CONN_ID" ]; then
  ffail "no connected Page — connect one at /facebook (Destinations) before running publish phases"
else
  pass "using connection $CONN_ID ($PAGE_NAME)"
fi

log "Create throwaway vehicle"
VEH=$(curl -s -X POST "$API/inventory" -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"title\":\"[CDMS SMOKE] FB Test Car\",\"company\":\"$MARK\",\"model\":\"Smoke\",\"year\":2022,\"price\":15000,\"fuelType\":\"petrol\",\"transmission\":\"automatic\",\"status\":\"unsold\"}")
VEHICLE_ID=$(printf '%s' "$VEH" | jget _id data)
if [ -z "$VEHICLE_ID" ]; then ffail "vehicle create failed: ${VEH:0:200}"; else pass "vehicle=$VEHICLE_ID"; fi

# ── A. Text Page post ────────────────────────────────────────────────────────
if [ -n "$CONN_ID" ] && [ -n "$VEHICLE_ID" ]; then
  log "A. Text Page post (real publish)"
  PUB=$(curl -s -X POST "$API/facebook/listings" -H "$H_AUTH" -H "$H_JSON" \
    -d "{\"vehicleId\":\"$VEHICLE_ID\",\"title\":\"[CDMS SMOKE TEST] please ignore\",\"description\":\"Automated CDMS smoke-test post — will be deleted.\",\"price\":15000,\"connectionIds\":[\"$CONN_ID\"],\"destinationType\":\"page\",\"publishNow\":true}")
  read -r LID STATUS FBPOST < <(printf '%s' "$PUB" | listing_fields)
  ERR=$(printf '%s' "$PUB" | listing_error)
  note "status=$STATUS fbPostId=$FBPOST"
  if [ "$STATUS" = "active" ] && [ -n "$FBPOST" ] && [ "$FBPOST" != "-" ]; then
    pass "text post published LIVE (fbPostId=$FBPOST)"
  else
    ffail "text publish not active: status=$STATUS lastError=$ERR"
  fi
  if [ -n "$LID" ] && [ "$LID" != "-" ]; then
    DEL=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/facebook/listings/$LID" -H "$H_AUTH")
    if [ "$DEL" = "200" ]; then pass "text listing removed (FB post deleted) [$DEL]"; else ffail "remove text listing http=$DEL"; fi
  fi
fi

# ── B. Photo Page post via S3 ────────────────────────────────────────────────
if [ -n "$CONN_ID" ] && [ -n "$VEHICLE_ID" ]; then
  log "B. Photo Page post via S3 (real)"
  # Generate a valid 600x400 PNG (so Facebook accepts the image fetch).
  node -e '
    const zlib=require("zlib"),fs=require("fs");
    const W=600,H=400;
    const tbl=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;tbl[n]=c>>>0;}
    const crc=b=>{let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=tbl[(c^b[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
    const ck=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const tt=Buffer.from(t);const cc=Buffer.alloc(4);cc.writeUInt32BE(crc(Buffer.concat([tt,d])),0);return Buffer.concat([l,tt,d,cc]);};
    const ih=Buffer.alloc(13);ih.writeUInt32BE(W,0);ih.writeUInt32BE(H,4);ih[8]=8;ih[9]=2;
    const row=Buffer.alloc(1+W*3);for(let x=0;x<W;x++){row[1+x*3]=37;row[2+x*3]=99;row[3+x*3]=235;}
    const raw=Buffer.concat(Array.from({length:H},()=>row));
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ck("IHDR",ih),ck("IDAT",zlib.deflateSync(raw)),ck("IEND",Buffer.alloc(0))]);
    fs.writeFileSync(process.argv[1],png);
  ' "$PNG"
  IMG=$(curl -s -X POST "$API/inventory/$VEHICLE_ID/images" -H "$H_AUTH" -F "images=@$PNG;type=image/png")
  S3URL=$(printf '%s' "$IMG" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);const p=(j.data&&j.data.photos)||[];process.stdout.write(p[p.length-1]||"");}catch(e){}})')
  rm -f "$PNG"
  note "photo url=$S3URL"
  case "$S3URL" in
    https://*amazonaws.com/*) pass "image uploaded to S3 (public URL)";;
    /uploads/*) ffail "image stored LOCALLY, not S3 — S3 not active? url=$S3URL";;
    *) ffail "image upload failed: ${IMG:0:200}";;
  esac
  if [ -n "$S3URL" ]; then
    PUB=$(curl -s -X POST "$API/facebook/listings" -H "$H_AUTH" -H "$H_JSON" \
      -d "{\"vehicleId\":\"$VEHICLE_ID\",\"title\":\"[CDMS SMOKE TEST] photo please ignore\",\"description\":\"Automated CDMS smoke-test photo post — will be deleted.\",\"price\":15000,\"photos\":[\"$S3URL\"],\"connectionIds\":[\"$CONN_ID\"],\"destinationType\":\"page\",\"publishNow\":true}")
    read -r LID STATUS FBPOST < <(printf '%s' "$PUB" | listing_fields)
    ERR=$(printf '%s' "$PUB" | listing_error)
    note "status=$STATUS fbPostId=$FBPOST"
    if [ "$STATUS" = "active" ] && [ -n "$FBPOST" ] && [ "$FBPOST" != "-" ]; then
      pass "PHOTO post published LIVE (fbPostId=$FBPOST)"
    else
      ffail "photo publish not active: status=$STATUS lastError=$ERR"
    fi
    if [ -n "$LID" ] && [ "$LID" != "-" ]; then
      DEL=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/facebook/listings/$LID" -H "$H_AUTH")
      if [ "$DEL" = "200" ]; then pass "photo listing removed [$DEL]"; else ffail "remove photo listing http=$DEL"; fi
    fi
  fi
fi

# ── C. Real Graph reads ──────────────────────────────────────────────────────
log "C. Real Graph reads (sync + analytics + inbox)"
check_ep() {
  local method="$1" path="$2"
  local code; code=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$API/$path" -H "$H_AUTH")
  if [ "$code" = "200" ] || [ "$code" = "201" ]; then pass "$method /$path -> $code"; else ffail "$method /$path -> $code"; fi
}
check_ep POST facebook/sync-conversations
check_ep GET  facebook/analytics
check_ep GET  facebook/comments
check_ep GET  facebook/conversations

# ── Cleanup ──────────────────────────────────────────────────────────────────
log "Cleanup"
[ -n "$VEHICLE_ID" ] && curl -s -o /dev/null -X DELETE "$API/inventory/$VEHICLE_ID" -H "$H_AUTH"
rm -f "$PNG"
echo "  done"

if [ "$FAILS" -eq 0 ]; then
  printf '\n✅ ALL FACEBOOK SMOKE CHECKS PASSED\n'
else
  printf '\n❌ %s FACEBOOK SMOKE CHECK(S) FAILED — see FAILs above\n' "$FAILS"
  exit 1
fi
