/**
 * BHPH close-options smoke — early payoff (+fee) and mark-defaulted.
 *   A) Early payoff: create a BHPH loan, POST /bhph/loans/:id/close
 *      { outcome:'payoff', earlyClosureFee } → loan paid_off, linked sale paid,
 *      an 'other' income row booked for the fee, and NO future interest booked
 *      beyond payments already made (payoff = remaining principal only).
 *   B) Defaulted: create a BHPH loan, record one EMI (books interest), then
 *      close { outcome:'defaulted' } → status defaulted, sale + interest KEPT.
 * Isolated throwaway vehicle/buyer; self-cleans. Backend must be running.
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

const uri = (readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8').match(/^MONGODB_URI=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '');
const { default: mongoose } = await import('mongoose');
await mongoose.connect(uri);
const coll = (c) => mongoose.connection.collection(c);
const oid = () => new mongoose.Types.ObjectId();
const vehIds = [], buyerIds = [];
const mkVehicle = async (n) => { const _id = oid(); await coll('vehicles').insertOne({ _id, title: `SMOKE CLO CAR ${n}`, vehicleNumber: `SMOKE-CLO-${n}`, status: '', isDeleted: false, price: 20000, costPrice: 14000, spends: [], createdAt: new Date(), updatedAt: new Date() }); vehIds.push(_id); return _id; };
const mkBuyer = async (n) => { const _id = oid(); await coll('buyer_leads').insertOne({ _id, buyerName: `SMOKE CLO Buyer ${n}`, buyerEmail: `smoke-clo-${n}@test.local`, buyerPhone: `555-19${n}0`, stage: 'new', isDeleted: false, purchases: [], createdAt: new Date(), updatedAt: new Date() }); buyerIds.push(_id); return _id; };

async function cleanup() {
  try {
    for (const v of vehIds) {
      const loans = await coll('loans').find({ vehicle: v }).toArray();
      for (const l of loans) await coll('incomes').deleteMany({ loanId: String(l._id) });
      await coll('loans').deleteMany({ vehicle: v });
      await coll('sales').deleteMany({ vehicleId: String(v) });
      await coll('leads').deleteMany({ vehicle: v });
      await coll('vehicles').deleteOne({ _id: v });
    }
    await coll('loans').deleteMany({ borrowerEmail: /smoke-clo/ });
    for (const b of buyerIds) await coll('buyer_leads').deleteOne({ _id: b });
    await coll('buyer_leads').deleteMany({ buyerEmail: /smoke-clo/ });
    await coll('notifications').deleteMany({ $or: [{ title: /SMOKE CLO CAR/ }, { body: /SMOKE CLO CAR/ }] });
    console.log('   cleanup done');
  } catch (e) { console.log('   cleanup error:', e.message); }
  await mongoose.disconnect();
}

async function main() {
  const t = tok((await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' })).d?.data);
  check('admin login', !!t);
  if (!t) return;

  // ── A) Early payoff (+fee) ────────────────────────────────────────────────
  const vA = await mkVehicle('A'); const bA = await mkBuyer('A');
  let r = await j('POST', '/bhph/loans', { vehicle: String(vA), buyerLeadId: String(bA), salePrice: 20000, downPayment: 5000, interestRatePercent: 12, termMonths: 12 }, t);
  check('A: create BHPH loan', r.status === 201 || r.status === 200, `status ${r.status}`);
  const loanAId = String(r.d?.data?._id ?? r.d?._id);
  const loanA = await coll('loans').findOne({ _id: new mongoose.Types.ObjectId(loanAId) });
  check('  loan principal 15000', loanA?.principal === 15000, `${loanA?.principal}`);
  const saleAId = loanA?.saleId;
  check('  linked sale exists (bhph/partial)', !!saleAId);

  r = await j('POST', `/bhph/loans/${loanAId}/close`, { outcome: 'payoff', earlyClosureFee: 300 }, t);
  check('A: payoff close ok', r.status === 201 || r.status === 200, `status ${r.status}`);
  const loanAAfter = await coll('loans').findOne({ _id: new mongoose.Types.ObjectId(loanAId) });
  check('  loan → paid_off', loanAAfter?.status === 'paid_off', loanAAfter?.status);
  const saleA = await coll('sales').findOne({ _id: new mongoose.Types.ObjectId(saleAId) });
  check('  linked sale → paid (amountPaid = net 20000)', saleA?.paymentStatus === 'paid' && Math.abs((saleA?.amountPaid ?? 0) - 20000) < 1, `${saleA?.paymentStatus}/${saleA?.amountPaid}`);
  const feeRows = await coll('incomes').find({ loanId: loanAId, source: 'bhph-early-closure-fee', isDeleted: { $ne: true } }).toArray();
  check('  early-closure fee booked as other income (300)', feeRows.length === 1 && feeRows[0].category === 'other' && Math.abs(feeRows[0].amount - 300) < 0.01, `rows=${feeRows.length} amt=${feeRows[0]?.amount}`);
  const interestRows = await coll('incomes').find({ loanId: loanAId, source: 'bhph-interest', isDeleted: { $ne: true } }).toArray();
  const interestSum = interestRows.reduce((s, i) => s + i.amount, 0);
  // No EMI payment was made before payoff → future interest waived → 0 interest income.
  check('  no future interest booked on payoff (interest income = 0)', interestSum < 0.01, `interest=$${interestSum.toFixed(2)}`);

  // ── B) Mark defaulted (keeps collected money + booked interest) ───────────
  const vB = await mkVehicle('B'); const bB = await mkBuyer('B');
  r = await j('POST', '/bhph/loans', { vehicle: String(vB), buyerLeadId: String(bB), salePrice: 24000, downPayment: 4000, interestRatePercent: 12, termMonths: 12 }, t);
  check('B: create BHPH loan', r.status === 201 || r.status === 200, `status ${r.status}`);
  const loanBId = String(r.d?.data?._id ?? r.d?._id);
  const loanB0 = await coll('loans').findOne({ _id: new mongoose.Types.ObjectId(loanBId) });
  const saleBId = loanB0?.saleId;
  // Record one EMI so some interest is booked.
  r = await j('POST', `/bhph/loans/${loanBId}/payment`, { amount: loanB0?.emiAmount ?? 1800 }, t);
  check('  recorded one EMI', r.status === 201 || r.status === 200, `status ${r.status}`);
  const interestBBefore = (await coll('incomes').find({ loanId: loanBId, source: 'bhph-interest', isDeleted: { $ne: true } }).toArray()).reduce((s, i) => s + i.amount, 0);
  check('  EMI booked some interest income', interestBBefore > 0, `$${interestBBefore.toFixed(2)}`);

  r = await j('POST', `/bhph/loans/${loanBId}/close`, { outcome: 'defaulted', note: 'stopped paying' }, t);
  check('B: defaulted close ok', r.status === 201 || r.status === 200, `status ${r.status}`);
  const loanBAfter = await coll('loans').findOne({ _id: new mongoose.Types.ObjectId(loanBId) });
  check('  loan → defaulted (+ defaultedAt)', loanBAfter?.status === 'defaulted' && !!loanBAfter?.defaultedAt, loanBAfter?.status);
  const saleB = await coll('sales').findOne({ _id: new mongoose.Types.ObjectId(saleBId) });
  check('  sale kept (not deleted, still partial)', saleB && saleB.isDeleted !== true && saleB.paymentStatus === 'partial', `${saleB?.paymentStatus}/${saleB?.isDeleted}`);
  const interestBAfter = (await coll('incomes').find({ loanId: loanBId, source: 'bhph-interest', isDeleted: { $ne: true } }).toArray()).reduce((s, i) => s + i.amount, 0);
  check('  booked interest income kept on default', Math.abs(interestBAfter - interestBBefore) < 0.01, `$${interestBAfter.toFixed(2)}`);

  console.log(`\nBHPH close-options smoke: ${pass} passed, ${fail} failed`);
}

try { await main(); } finally { await cleanup(); }
process.exit(fail ? 1 : 0);
