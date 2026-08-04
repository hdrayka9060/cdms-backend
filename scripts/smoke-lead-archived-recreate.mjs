// Smoke: archived leads release the buyer×vehicle slot ("archived = deleted").
// Reproduces the fix for the stale unique (buyer, vehicle) partial index:
//   1. Create lead L1 for (B, V).
//   2. Archive L1.
//   3. Create L2 for the SAME (B, V)  -> must SUCCEED (previously E11000 dup-key).
//   4. Create L3 for the SAME (B, V) while L2 is active -> must be BLOCKED (409,
//      status-aware Guard 2). Confirms uniqueness is still enforced for
//      non-archived leads.
// All created leads are hard-removed at the end. Picks a non-sold vehicle and a
// buyer whose pair currently has no lead, so no real demo data is disturbed.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3000/api/v1';
const STAFF_PW = process.env.SMOKE_PW || 'Welcome@123';
let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(40)} got=${got}  want=${want}`);
};

if (!process.env.MONGODB_URI) { console.error('MONGODB_URI missing'); process.exit(2); }
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

// ── Confirm the stale unique index is gone ────────────────────────────────
const idx = await db.collection('leads').indexes();
const staleUnique = idx.find(
  (i) => i.unique && i.key && Object.keys(i.key).length === 2 && i.key.buyer === 1 && i.key.vehicle === 1,
);
check('stale (buyer,vehicle) unique index dropped', !staleUnique, true);

// ── Actor: a non-admin with Leads:edit (seeded pw Welcome@123) ────────────
const hasAction = (perms, mod, action) =>
  (perms || []).some((p) => p.module === mod && (p.actions || []).includes(action));
const roles = await db.collection('roles').find({ isDeleted: { $ne: true } }).toArray();
const rolesById = new Map(roles.map((r) => [String(r._id), r]));
const users = await db.collection('users')
  .find({ isDeleted: { $ne: true }, status: 'active', password: { $exists: true, $ne: null } }).toArray();
let actor = null;
for (const u of users) {
  const role = rolesById.get(String(u.roleId));
  if (role && role.name !== 'Admin' && hasAction(role.permissions, 'Leads & Sales', 'edit')) { actor = u; break; }
}
if (!actor) { console.error('No non-admin Leads:edit user found.'); process.exit(1); }

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: actor.email, password: STAFF_PW }),
}).then((r) => r.json());
const token = login?.data?.accessToken || login?.data?.access_token;
if (!token) { console.error(`Login failed for ${actor.email}`); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
console.log(`\nActor: ${actor.email} (role=${rolesById.get(String(actor.roleId))?.name})`);

// ── Pick a non-sold vehicle V + a buyer B whose pair has no existing lead ──
const vehicle = await db.collection('vehicles').findOne({ isDeleted: false, status: { $ne: 'sold' } });
if (!vehicle) { console.error('No available (non-sold) vehicle found.'); process.exit(1); }
const buyers = await db.collection('buyer_leads').find({ isDeleted: false }).limit(50).toArray();
let buyer = null;
for (const b of buyers) {
  const existing = await db.collection('leads').countDocuments({ buyer: b._id, vehicle: vehicle._id, isDeleted: false });
  if (existing === 0) { buyer = b; break; }
}
if (!buyer) { console.error('Could not find a buyer with a clean pair for this vehicle.'); process.exit(1); }
console.log(`Pair: buyer=${buyer._id} vehicle=${vehicle._id} (${vehicle.title})`);

const B = String(buyer._id), V = String(vehicle._id);
const created = [];
const mkLead = () => fetch(`${BASE}/leads`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ buyer: B, vehicle: V, source: 'walk_in', status: 'new' }),
});

try {
  // 1. Create L1
  const r1 = await mkLead();
  const b1 = await r1.json();
  const l1 = b1?.data?.id || b1?.data?._id;
  if (l1) created.push(l1);
  check('L1 create HTTP 2xx', r1.ok, true);

  // 2. Archive L1
  const ra = await fetch(`${BASE}/leads/${l1}`, { method: 'PATCH', headers: H, body: JSON.stringify({ status: 'archived' }) });
  check('L1 archive HTTP 2xx', ra.ok, true);
  const l1doc = await db.collection('leads').findOne({ _id: new mongoose.Types.ObjectId(l1) });
  check('L1 status == archived', l1doc?.status, 'archived');

  // 3. Create L2 for the SAME (B, V) — the fix: must succeed now
  const r2 = await mkLead();
  const b2 = await r2.json();
  const l2 = b2?.data?.id || b2?.data?._id;
  if (l2) created.push(l2);
  check('L2 re-create after archive HTTP 2xx', r2.ok, true);
  if (!r2.ok) console.log('    L2 response:', JSON.stringify(b2).slice(0, 250));

  // 4. Create L3 while L2 active — Guard 2 must still block (409)
  const r3 = await mkLead();
  const b3 = await r3.json();
  const l3 = b3?.data?.id || b3?.data?._id;
  if (l3) created.push(l3);
  check('L3 blocked while L2 active (HTTP 409)', r3.status, 409);
  check('L3 error mentions "already exists"', /already exists/i.test(b3?.message || ''), true);
} finally {
  // ── Cleanup: hard-remove every lead we created ──────────────────────────
  console.log('\n=== Cleanup ===');
  for (const id of created) {
    const r = await db.collection('leads').deleteOne({ _id: new mongoose.Types.ObjectId(id) });
    console.log(`  lead ${id} removed: deletedCount=${r.deletedCount}`);
  }
  await mongoose.disconnect();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
