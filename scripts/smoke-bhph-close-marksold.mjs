/**
 * BHPH Phase 6 smoke — close-lead & mark-sold auto-create a linked BHPH loan
 * when paymentMethod = 'bhph'.
 *   A) POST /leads/:id/close  { paymentMethod:'bhph', amountPaid, rate, term }
 *      → a BHPH loan is created, linked to the sale + lead; down payment applied.
 *   B) POST /inventory/:id/mark-sold { paymentMethod:'bhph', buyer, amountPaid, ... }
 *      → a BHPH loan is created, linked to the sale.
 *   C) validation: bhph close/mark-sold missing down payment / EMI / buyer → 400
 *      (and no orphan sale is left behind).
 *
 * Isolated throwaway lead/buyer/vehicle; self-cleans. Backend must be running.
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
const vehIds = [], leadIds = [], buyerIds = [];
const mkVehicle = async (n) => { const _id = oid(); await coll('vehicles').insertOne({ _id, title: `SMOKE P6 CAR ${n}`, vehicleNumber: `SMOKE-P6-${n}`, status: '', isDeleted: false, price: 20000, costPrice: 14000, spends: [], createdAt: new Date(), updatedAt: new Date() }); vehIds.push(_id); return _id; };
const mkBuyer = async (n) => { const _id = oid(); await coll('buyer_leads').insertOne({ _id, buyerName: `SMOKE P6 Buyer ${n}`, buyerEmail: `smoke-p6-${n}@test.local`, buyerPhone: `555-06${n}0`, stage: 'new', isDeleted: false, purchases: [], createdAt: new Date(), updatedAt: new Date() }); buyerIds.push(_id); return _id; };

async function cleanup() {
  try {
    for (const v of vehIds) {
      const loans = await coll('loans').find({ vehicle: v }).toArray();
      for (const l of loans) await coll('incomes').deleteMany({ loanId: String(l._id) });
      await coll('loans').deleteMany({ vehicle: v });
      await coll('sales').deleteMany({ vehicleId: String(v) });
      await coll('vehicles').deleteOne({ _id: v });
    }
    await coll('loans').deleteMany({ borrowerEmail: /smoke-p6/ });
    for (const l of leadIds) await coll('leads').deleteOne({ _id: l });
    await coll('leads').deleteMany({ notes: 'SMOKE-P6-LEAD' });
    for (const b of buyerIds) await coll('buyer_leads').deleteOne({ _id: b });
    await coll('buyer_leads').deleteMany({ buyerEmail: /smoke-p6/ });
    await coll('notifications').deleteMany({ $or: [{ title: /SMOKE P6 CAR/ }, { body: /SMOKE P6 CAR/ }] });
    console.log('   cleanup done');
  } catch (e) { console.log('   cleanup error:', e.message); }
  await mongoose.disconnect();
}

async function main() {
  const t = tok((await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' })).d?.data);
  check('admin login', !!t);
  if (!t) return;

  // ── A) Close a lead with BHPH → linked loan ───────────────────────────────
  const vA = await mkVehicle('A'); const bA = await mkBuyer('A'); const leadA = oid(); leadIds.push(leadA);
  await coll('leads').insertOne({ _id: leadA, buyer: bA, vehicle: vA, status: 'new', source: 'walk_in', isDeleted: false, notes: 'SMOKE-P6-LEAD', timeline: [], log: [], createdAt: new Date(), updatedAt: new Date() });
  let r = await j('POST', `/leads/${leadA}/close`, { soldAt: 20000, amountPaid: 5000, paymentMethod: 'bhph', paymentStatus: 'partial', interestRatePercent: 12, termMonths: 24 }, t);
  check('A: close lead (bhph) ok', r.status === 200 || r.status === 201, `status ${r.status}`);
  const loanA = await coll('loans').findOne({ vehicle: vA, isDeleted: false });
  check('  BHPH loan created + linked to lead + sale', !!loanA && String(loanA.leadId) === String(leadA) && !!loanA.saleId, `loan=${!!loanA}`);
  check('  loan financed = price − down (15000), down 5000', loanA?.principal === 15000 && loanA?.downPayment === 5000, `${loanA?.principal}/${loanA?.downPayment}`);
  const saleA = await coll('sales').findOne({ vehicleId: String(vA), isDeleted: false });
  check('  sale is bhph/partial, amountPaid = down 5000', saleA?.paymentMethod === 'bhph' && saleA?.paymentStatus === 'partial' && Math.abs(saleA?.amountPaid - 5000) < 1, `${saleA?.paymentMethod}/${saleA?.paymentStatus}/${saleA?.amountPaid}`);

  // ── B) Mark a vehicle sold with BHPH → linked loan ────────────────────────
  const vB = await mkVehicle('B'); const bB = await mkBuyer('B');
  r = await j('POST', `/inventory/${vB}/mark-sold`, { salePrice: 20000, discount: 0, amountPaid: 4000, saleDate: new Date().toISOString().slice(0, 10), paymentMethod: 'bhph', paymentStatus: 'partial', buyerLeadId: String(bB), interestRatePercent: 10, termMonths: 36 }, t);
  check('B: mark-sold (bhph) ok', r.status === 200 || r.status === 201, `status ${r.status}`);
  const loanB = await coll('loans').findOne({ vehicle: vB, isDeleted: false });
  check('  BHPH loan created + linked to sale', !!loanB && !!loanB.saleId && String(loanB.buyerLeadId) === String(bB));
  check('  loan financed 16000, down 4000', loanB?.principal === 16000 && loanB?.downPayment === 4000, `${loanB?.principal}/${loanB?.downPayment}`);
  const vehB = await coll('vehicles').findOne({ _id: vB });
  check('  vehicle flipped to sold', vehB?.status === 'sold');

  // ── C) Validation — no orphan sale on bad BHPH input ──────────────────────
  const vC = await mkVehicle('C'); const bC = await mkBuyer('C'); const leadC = oid(); leadIds.push(leadC);
  await coll('leads').insertOne({ _id: leadC, buyer: bC, vehicle: vC, status: 'new', source: 'walk_in', isDeleted: false, notes: 'SMOKE-P6-LEAD', timeline: [], log: [], createdAt: new Date(), updatedAt: new Date() });
  // Missing down payment.
  r = await j('POST', `/leads/${leadC}/close`, { soldAt: 20000, paymentMethod: 'bhph', paymentStatus: 'partial', interestRatePercent: 12, termMonths: 24 }, t, false);
  check('C: close bhph without down payment → 400', r.status === 400);
  // Only one EMI input.
  r = await j('POST', `/leads/${leadC}/close`, { soldAt: 20000, amountPaid: 5000, paymentMethod: 'bhph', paymentStatus: 'partial', interestRatePercent: 12 }, t, false);
  check('  close bhph with only 1 EMI input → 400', r.status === 400);
  const orphan = await coll('sales').findOne({ vehicleId: String(vC), isDeleted: false });
  check('  no orphan sale left after failed close', !orphan);
  const leadCstill = await coll('leads').findOne({ _id: leadC });
  check('  lead not closed by failed attempt', leadCstill?.status !== 'closed', leadCstill?.status);
  // mark-sold bhph without buyer → 400
  const vD = await mkVehicle('D');
  r = await j('POST', `/inventory/${vD}/mark-sold`, { salePrice: 20000, amountPaid: 4000, saleDate: new Date().toISOString().slice(0, 10), paymentMethod: 'bhph', interestRatePercent: 10, termMonths: 36 }, t, false);
  check('  mark-sold bhph without buyer → 400', r.status === 400);
  const orphanD = await coll('sales').findOne({ vehicleId: String(vD), isDeleted: false });
  check('  no orphan sale for buyerless bhph mark-sold', !orphanD);

  console.log(`\nBHPH Phase 6 smoke: ${pass} passed, ${fail} failed`);
}

try { await main(); } finally { await cleanup(); }
process.exit(fail ? 1 : 0);
