/**
 * BHPH Phase 4 smoke — party resolution on loan create:
 *   A) from a lead        → borrower + vehicle auto-filled
 *   B) inline new buyer   → CRM buyer created (dedupe) + linked
 *   C) existing buyerId   → borrower filled from the buyer
 *   D) validation         → no borrower/buyer/lead → 400
 *
 * All actors are ISOLATED throwaway docs (marker 'smoke-p4') inserted via
 * mongoose, and everything is cleaned up afterward. Backend must be running.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'http://localhost:3000/api/v1';
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };
const j = async (m, p, b, t, expectOk = true) => {
  const res = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let d; try { d = await res.json(); } catch { d = null; }
  if (expectOk && res.status >= 400) console.log(`   ! ${m} ${p} -> ${res.status} ${JSON.stringify(d?.message)}`);
  return { status: res.status, d };
};
const tok = (o) => o?.accessToken || o?.access_token || o?.token || o?.tokens?.accessToken;

const uri = (readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8').match(/^MONGODB_URI=(.+)$/m) || [])[1]?.trim();
const { default: mongoose } = await import('mongoose');
await mongoose.connect(uri);
const coll = (c) => mongoose.connection.collection(c);
const oid = () => new mongoose.Types.ObjectId();

const vehIds = [], loanIds = [];
const mkVehicle = async (n) => { const _id = oid(); await coll('vehicles').insertOne({ _id, title: `SMOKE P4 CAR ${n}`, vehicleNumber: `SMOKE-P4-${n}`, status: '', isDeleted: false, price: 15000, costPrice: 9000, spends: [], createdAt: new Date(), updatedAt: new Date() }); vehIds.push(_id); return _id; };
const mkBuyer = async (n) => { const _id = oid(); await coll('buyer_leads').insertOne({ _id, buyerName: `SMOKE P4 Buyer ${n}`, buyerEmail: `smoke-p4-buyer${n}@test.local`, buyerPhone: `555-04${n}0`, stage: 'new', isDeleted: false, purchases: [], createdAt: new Date(), updatedAt: new Date() }); return _id; };

async function cleanup() {
  try {
    for (const id of loanIds) await coll('loans').deleteOne({ _id: new mongoose.Types.ObjectId(id) });
    await coll('loans').deleteMany({ borrowerEmail: /smoke-p4|newbuyer-smoke/ });
    for (const v of vehIds) { await coll('sales').deleteMany({ vehicleId: String(v) }); await coll('vehicles').deleteOne({ _id: v }); }
    for (const id of loanIds) await coll('incomes').deleteMany({ loanId: String(id) });
    await coll('buyer_leads').deleteMany({ buyerEmail: /smoke-p4|newbuyer-smoke/ });
    await coll('leads').deleteMany({ notes: 'SMOKE-P4-LEAD' });
    await coll('notifications').deleteMany({ $or: [{ title: /SMOKE P4 CAR/ }, { body: /SMOKE P4 CAR/ }] });
    console.log('   cleanup done');
  } catch (e) { console.log('   cleanup error:', e.message); }
  await mongoose.disconnect();
}

async function main() {
  const t = tok((await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' })).d?.data);
  check('admin login', !!t);
  if (!t) return;
  const terms = { salePrice: 15000, downPayment: 3000, interestRatePercent: 12, termMonths: 12, startDate: new Date().toISOString().slice(0, 10) };

  // A) From a lead.
  const vA = await mkVehicle('A'); const bA = await mkBuyer('A'); const leadId = oid();
  await coll('leads').insertOne({ _id: leadId, buyer: bA, vehicle: vA, status: 'new', source: 'walk_in', isDeleted: false, notes: 'SMOKE-P4-LEAD', timeline: [], log: [], createdAt: new Date(), updatedAt: new Date() });
  let r = await j('POST', '/bhph/loans', { leadId: String(leadId), ...terms }, t);
  let loan = r.d?.data; if (loan?._id) loanIds.push(loan._id);
  check('A: create from lead', r.status === 201 && !!loan?._id);
  check('  borrower auto-filled from lead buyer', loan?.borrowerName === 'SMOKE P4 Buyer A' && loan?.borrowerEmail === 'smoke-p4-buyerA@test.local', loan?.borrowerName);
  check('  vehicle auto-filled from lead', String(loan?.vehicle) === String(vA), `${loan?.vehicle}`);
  check('  buyerLeadId + leadId linked', String(loan?.buyerLeadId) === String(bA) && String(loan?.leadId) === String(leadId));
  check('  sale created + linked', !!loan?.saleId);

  // B) Inline new buyer.
  const vB = await mkVehicle('B');
  r = await j('POST', '/bhph/loans', { vehicle: String(vB), newBuyerName: 'Inline Smoke', newBuyerEmail: 'newbuyer-smoke@test.local', newBuyerPhone: '555-0999', vehicleTitle: 'SMOKE P4 CAR B', ...terms }, t);
  loan = r.d?.data; if (loan?._id) loanIds.push(loan._id);
  check('B: create with inline new buyer', r.status === 201 && !!loan?._id);
  check('  borrower = inline buyer', loan?.borrowerEmail === 'newbuyer-smoke@test.local' && loan?.borrowerPhone === '555-0999');
  const createdBuyer = await coll('buyer_leads').findOne({ buyerEmail: 'newbuyer-smoke@test.local' });
  check('  CRM buyer created + linked', !!createdBuyer && String(loan?.buyerLeadId) === String(createdBuyer._id));

  // B2) Same email again → dedupe/link, not a duplicate or 500.
  const vB2 = await mkVehicle('B2');
  r = await j('POST', '/bhph/loans', { vehicle: String(vB2), newBuyerName: 'Inline Smoke', newBuyerEmail: 'newbuyer-smoke@test.local', newBuyerPhone: '555-0999', vehicleTitle: 'SMOKE P4 CAR B2', ...terms }, t);
  if (r.d?.data?._id) loanIds.push(r.d.data._id);
  const buyerCount = await coll('buyer_leads').countDocuments({ buyerEmail: 'newbuyer-smoke@test.local' });
  check('B2: duplicate email dedupes to one buyer', r.status === 201 && buyerCount === 1, `count=${buyerCount}`);

  // C) Existing buyer id.
  const vC = await mkVehicle('C'); const bC = await mkBuyer('C');
  r = await j('POST', '/bhph/loans', { vehicle: String(vC), buyerLeadId: String(bC), vehicleTitle: 'SMOKE P4 CAR C', ...terms }, t);
  loan = r.d?.data; if (loan?._id) loanIds.push(loan._id);
  check('C: create with existing buyerId', r.status === 201 && loan?.borrowerName === 'SMOKE P4 Buyer C' && String(loan?.buyerLeadId) === String(bC));

  // D) No borrower/buyer/lead → 400.
  r = await j('POST', '/bhph/loans', { ...terms }, t, false);
  check('D: no party → 400', r.status === 400, `status ${r.status}`);

  console.log(`\nBHPH Phase 4 smoke: ${pass} passed, ${fail} failed`);
}

try { await main(); } finally { await cleanup(); }
process.exit(fail ? 1 : 0);
