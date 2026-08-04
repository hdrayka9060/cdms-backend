// Smoke: costPrice on the "Add Vehicle" create paths.
// Proves the contract the three frontend forms depend on:
//   1. POST /inventory              (Inventory page inline form)
//   2. POST /crm/sellers/:id/vehicles (Add-Seller form + Seller-detail dialog,
//      both via the shared VehicleFormDialog → toServerVehiclePayload)
// For each, we send a costPrice and assert it persisted on the raw vehicles doc.
// Creates are cleaned up (soft-delete via API + hard remove of the test seller).
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3000/api/v1';
const STAFF_PW = process.env.SMOKE_PW || 'Welcome@123';
const COST_INV = 13579;
const COST_SELLER = 24680;

let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} got=${got}  want=${want}`);
};

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI missing from cdms-backend/.env — cannot run smoke test.');
  process.exit(2);
}
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

// ── Find an active, password-set user whose role grants Inventory:edit AND
//    CRM-Sellers:edit (Sales Manager fits). Falls back to Inventory:edit only.
const hasAction = (perms, mod, action) =>
  (perms || []).some((p) => p.module === mod && (p.actions || []).includes(action));

const roles = await db.collection('roles').find({ isDeleted: { $ne: true } }).toArray();
const rolesById = new Map(roles.map((r) => [String(r._id), r]));
const users = await db.collection('users')
  .find({ isDeleted: { $ne: true }, status: 'active', password: { $exists: true, $ne: null } })
  .toArray();

// Prefer a NON-admin staff member (seeded with pw Welcome@123). The Admin's
// password was preserved on the demo reset and is unknown to this script.
let actor = null;
let sellerCapable = false;
let adminFallback = null;
for (const u of users) {
  const role = rolesById.get(String(u.roleId));
  if (!role) continue;
  const inv = hasAction(role.permissions, 'Inventory', 'edit');
  const sel = hasAction(role.permissions, 'CRM – Sellers', 'edit');
  if (!inv) continue;
  const isAdmin = role.name === 'Admin';
  if (isAdmin) { adminFallback = adminFallback || u; continue; }
  if (inv && sel) { actor = u; sellerCapable = true; break; }   // ideal: both paths
  if (inv && !actor) actor = u;                                  // inventory-only staff
}
if (!actor) {
  actor = adminFallback;
  sellerCapable = actor ? hasAction(rolesById.get(String(actor.roleId))?.permissions, 'CRM – Sellers', 'edit') : false;
  if (actor) console.warn('WARN: only the Admin has the needed perms; login will likely fail unless SMOKE_PW is set to the admin password.');
}
if (!actor) { console.error('No active Inventory:edit user found to drive the smoke test.'); process.exit(1); }
console.log(`\nActor: ${actor.email}  (role=${rolesById.get(String(actor.roleId))?.name}, sellerCapable=${sellerCapable})`);

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: actor.email, password: STAFF_PW }),
}).then((r) => r.json());
const token = login?.data?.accessToken || login?.data?.access_token;
if (!token) { console.error(`Login failed for ${actor.email} (pw=${STAFF_PW}). Set SMOKE_PW if different.`); process.exit(1); }
const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

const stamp = String(Date.now()).slice(-6);
const createdVehicleIds = [];
let createdSellerId = null;

// ── Test 1: POST /inventory with costPrice ────────────────────────────────
console.log('\n=== Test 1: POST /inventory (Inventory inline form) ===');
{
  const res = await fetch(`${BASE}/inventory`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      title: `SMOKE CostPrice ${stamp}`, company: 'SmokeCo', model: 'CP1',
      year: 2022, price: 30000, costPrice: COST_INV, hosting: 'self',
    }),
  });
  const body = await res.json();
  const id = body?.data?.id || body?.data?._id;
  check('POST /inventory HTTP 2xx', res.ok, true);
  if (id) {
    createdVehicleIds.push(id);
    const doc = await db.collection('vehicles').findOne({ _id: new mongoose.Types.ObjectId(id) });
    check('vehicle.costPrice persisted', doc?.costPrice, COST_INV);
  } else {
    failures++;
    console.log('  FAIL  no vehicle id returned:', JSON.stringify(body).slice(0, 200));
  }
}

// ── Test 2: POST /crm/sellers/:id/vehicles with costPrice ─────────────────
console.log('\n=== Test 2: POST /crm/sellers/:id/vehicles (shared VehicleFormDialog) ===');
if (!sellerCapable) {
  console.log('  SKIP  actor lacks CRM – Sellers:edit — cannot exercise seller path.');
} else {
  const sres = await fetch(`${BASE}/crm/sellers`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      sellerName: `SMOKE Seller ${stamp}`,
      sellerEmail: `smoke.seller.${stamp}@example.com`,
      sellerPhone: '4160000000',
    }),
  });
  const sbody = await sres.json();
  createdSellerId = sbody?.data?.id || sbody?.data?._id;
  check('POST /crm/sellers HTTP 2xx', sres.ok, true);
  if (!sres.ok) console.log('  seller-create response:', JSON.stringify(sbody).slice(0, 250));
  if (createdSellerId) {
    const vres = await fetch(`${BASE}/crm/sellers/${createdSellerId}/vehicles`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        title: `SMOKE Seller Veh ${stamp}`, company: 'SmokeCo', model: 'CP2',
        year: 2023, price: 40000, costPrice: COST_SELLER, hosting: 'platform',
      }),
    });
    const vbody = await vres.json();
    check('POST seller vehicle HTTP 2xx', vres.ok, true);
    const vid = vbody?.data?.vehicle?._id || vbody?.data?.vehicle?.id;
    if (vid) {
      createdVehicleIds.push(vid);
      const doc = await db.collection('vehicles').findOne({ _id: new mongoose.Types.ObjectId(vid) });
      check('seller vehicle.costPrice persisted', doc?.costPrice, COST_SELLER);
    } else {
      failures++;
      console.log('  FAIL  no seller-vehicle id returned:', JSON.stringify(vbody).slice(0, 200));
    }
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────
// Hard-remove the test artifacts directly (the Sales-Manager actor lacks
// Inventory:delete, so the API DELETE would 403). These are throwaway smoke rows.
console.log('\n=== Cleanup ===');
for (const id of createdVehicleIds) {
  const r = await db.collection('vehicles').deleteOne({ _id: new mongoose.Types.ObjectId(id) });
  console.log(`  vehicle ${id} removed: deletedCount=${r.deletedCount}`);
}
if (createdSellerId) {
  await db.collection('seller_leads').deleteOne({ _id: new mongoose.Types.ObjectId(createdSellerId) });
  console.log(`  seller ${createdSellerId} removed from seller_leads`);
}

await mongoose.disconnect();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
