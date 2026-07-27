// Smoke: GET /inventory/:id/activity vs DB-computed expectations.
// Verifies views / inquiries / testDrives + the merged 4-source comms log.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const VID = process.argv[2] || '6a3a1297b44df5cf5d55294d';
const BASE = 'http://localhost:3000/api/v1';
let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} got=${got}  want=${want}`);
};

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const oid = new mongoose.Types.ObjectId(VID);

const vehicle = await db.collection('vehicles').findOne({ _id: oid });
const expViews = vehicle.traffic?.views ?? 0;
const expInq = await db.collection('leads').countDocuments({ vehicle: oid, source: 'website', isDeleted: false });
const expTd = await db.collection('calendar_events').countDocuments({ eventType: 'test_drive', vehicle: oid, isDeleted: false });

// Expected log counts per source
const comm = await db.collection('communication_logs').countDocuments({ linkedVehicle: oid });
const leadLogAgg = await db.collection('leads').aggregate([
  { $match: { vehicle: oid, isDeleted: false } },
  { $project: { n: { $size: { $ifNull: ['$log', []] } } } },
  { $group: { _id: null, t: { $sum: '$n' } } },
]).toArray();
const leadLog = leadLogAgg[0]?.t || 0;
const buyerAgg = await db.collection('buyer_leads').aggregate([
  { $match: { isDeleted: false, 'communications.vehicle': oid } },
  { $project: { c: { $filter: { input: { $ifNull: ['$communications', []] }, as: 'x', cond: { $eq: ['$$x.vehicle', oid] } } } } },
  { $project: { n: { $size: '$c' } } },
  { $group: { _id: null, t: { $sum: '$n' } } },
]).toArray();
const buyerLog = buyerAgg[0]?.t || 0;
const sellerOr = [{ vehicles: oid }];
if (vehicle.seller) sellerOr.push({ _id: vehicle.seller });
const sellerAgg = await db.collection('seller_leads').aggregate([
  { $match: { isDeleted: false, $or: sellerOr } },
  { $project: { n: { $size: { $ifNull: ['$communications', []] } } } },
  { $group: { _id: null, t: { $sum: '$n' } } },
]).toArray();
const sellerLog = sellerAgg[0]?.t || 0;
const expLogsTotal = comm + leadLog + buyerLog + sellerLog;

console.log(`\n=== Vehicle ${VID} (${vehicle.title}) ===`);
console.log(`  expected: views=${expViews} inquiries=${expInq} testDrives=${expTd}`);
console.log(`  expected logs: comm=${comm} lead=${leadLog} buyer=${buyerLog} seller=${sellerLog}  total=${expLogsTotal}`);

// Hit the live endpoint (login as an Inventory:view user)
const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' }),
}).then((r) => r.json());
const token = login?.data?.accessToken || login?.data?.access_token;
if (!token) { console.error('login failed'); process.exit(1); }

const res = await fetch(`${BASE}/inventory/${VID}/activity`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) { console.error(`endpoint HTTP ${res.status}`); process.exit(1); }
const { data } = await res.json();
const bySource = (data.logs || []).reduce((m, l) => { m[l.source] = (m[l.source] || 0) + 1; return m; }, {});

console.log(`\n=== API /inventory/:id/activity ===`);
console.log(`  api: views=${data.views} inquiries=${data.inquiries} testDrives=${data.testDrives} logs=${data.logs.length}`);
console.log(`  api logs by source:`, JSON.stringify(bySource));

check('views', data.views, expViews);
check('inquiries', data.inquiries, expInq);
check('testDrives', data.testDrives, expTd);
// logs capped at 50 in the endpoint
check('logs total', data.logs.length, Math.min(50, expLogsTotal));
// logs sorted newest-first
const sorted = [...data.logs].every((l, i, a) => i === 0 || a[i - 1].date >= l.date);
check('logs newest-first', sorted, true);

await mongoose.disconnect();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
