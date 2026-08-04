// Smoke: PATCH /inventory/:id/images/order reorders photos[] and the new order
// is reflected on the PUBLIC storefront endpoint too.
//   1. Pick a vehicle with >= 2 photos; remember its original order.
//   2. Reorder (rotate: move the last photo to the front) via the admin API.
//   3. Assert the vehicles doc + admin GET + public /website/inventory/:id all
//      show the new order (cover = the moved photo).
//   4. Negative: a list that drops a photo is rejected (400).
//   5. Restore the original order (leave demo data untouched).
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
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`);
};

if (!process.env.MONGODB_URI) { console.error('MONGODB_URI missing'); process.exit(2); }
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

// Actor: non-admin with Inventory:edit (seeded pw Welcome@123)
const hasAction = (perms, mod, action) => (perms || []).some((p) => p.module === mod && (p.actions || []).includes(action));
const roles = await db.collection('roles').find({ isDeleted: { $ne: true } }).toArray();
const rolesById = new Map(roles.map((r) => [String(r._id), r]));
const users = await db.collection('users').find({ isDeleted: { $ne: true }, status: 'active', password: { $exists: true, $ne: null } }).toArray();
let actor = null;
for (const u of users) {
  const role = rolesById.get(String(u.roleId));
  if (role && role.name !== 'Admin' && hasAction(role.permissions, 'Inventory', 'edit')) { actor = u; break; }
}
if (!actor) { console.error('No non-admin Inventory:edit user found.'); process.exit(1); }
const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: actor.email, password: STAFF_PW }),
}).then((r) => r.json());
const token = login?.data?.accessToken || login?.data?.access_token;
if (!token) { console.error(`Login failed for ${actor.email}`); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
console.log(`Actor: ${actor.email}`);

// Pick a vehicle with >= 2 photos
const veh = await db.collection('vehicles').findOne({ isDeleted: false, 'photos.1': { $exists: true } });
if (!veh) { console.error('No vehicle with >= 2 photos found.'); process.exit(1); }
const VID = String(veh._id);
const original = [...veh.photos];
console.log(`Vehicle ${VID} (${veh.title}) has ${original.length} photos\n`);

// New order: rotate last -> front
const reordered = [original[original.length - 1], ...original.slice(0, -1)];

try {
  // 2+3. Reorder via admin API
  const r = await fetch(`${BASE}/inventory/${VID}/images/order`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ photos: reordered }),
  });
  const body = await r.json();
  check('PATCH images/order HTTP 200', r.status, 200);

  const doc = await db.collection('vehicles').findOne({ _id: veh._id });
  check('DB photos[] == new order', doc.photos, reordered);

  const adminGet = await fetch(`${BASE}/inventory/${VID}`, { headers: H }).then((x) => x.json());
  check('admin GET photos[] == new order', adminGet?.data?.photos, reordered);

  const pub = await fetch(`${BASE}/website/inventory/${VID}`).then((x) => x.json());
  check('public storefront photos[] == new order', pub?.data?.photos, reordered);
  check('public cover (photos[0]) == moved photo', pub?.data?.photos?.[0], reordered[0]);

  // 4. Negative: dropping a photo is rejected
  const bad = await fetch(`${BASE}/inventory/${VID}/images/order`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ photos: reordered.slice(1) }),
  });
  check('reject list with a dropped photo (HTTP 400)', bad.status, 400);
} finally {
  // 5. Restore original order
  const restore = await fetch(`${BASE}/inventory/${VID}/images/order`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ photos: original }),
  });
  const restored = await db.collection('vehicles').findOne({ _id: veh._id });
  console.log(`\nRestored original order (HTTP ${restore.status}):`, JSON.stringify(restored.photos) === JSON.stringify(original) ? 'OK' : 'MISMATCH');
  await mongoose.disconnect();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
