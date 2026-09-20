/**
 * Mark-unsold smoke — reversing a sale from Inventory:
 *   A) BHPH-financed sale → loan archived (income backed out), sale soft-deleted, car un-sold
 *   B) partial cash sale (receivable) → receivable archived, sale soft-deleted, car un-sold
 *   C) validation: un-sell a not-sold car → 400
 * Isolated throwaway vehicles; self-cleans.
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
const vehIds = [], loanIds = [], buyerIds = [];
const mkVehicle = async (n) => { const _id = oid(); await coll('vehicles').insertOne({ _id, title: `SMOKE UNSOLD CAR ${n}`, vehicleNumber: `SMOKE-UNSOLD-${n}`, status: '', isDeleted: false, price: 20000, costPrice: 14000, spends: [], createdAt: new Date(), updatedAt: new Date() }); vehIds.push(_id); return _id; };
const mkBuyer = async (n) => { const _id = oid(); await coll('buyer_leads').insertOne({ _id, buyerName: `Unsold Buyer ${n}`, buyerEmail: `smoke-unsold-${n}@test.local`, buyerPhone: `555-08${n}0`, stage: 'new', isDeleted: false, purchases: [], createdAt: new Date(), updatedAt: new Date() }); buyerIds.push(_id); return _id; };

async function cleanup() {
  try {
    for (const id of loanIds) { await coll('loans').deleteOne({ _id: new mongoose.Types.ObjectId(id) }); await coll('incomes').deleteMany({ loanId: String(id) }); }
    for (const v of vehIds) {
      const sales = await coll('sales').find({ vehicleId: String(v) }).toArray();
      for (const s of sales) await coll('receivables').deleteMany({ saleId: String(s._id) });
      await coll('loans').deleteMany({ vehicle: v });
      await coll('sales').deleteMany({ vehicleId: String(v) });
      await coll('vehicles').deleteOne({ _id: v });
    }
    for (const b of buyerIds) await coll('buyer_leads').deleteOne({ _id: b });
    await coll('notifications').deleteMany({ $or: [{ title: /SMOKE UNSOLD CAR/ }, { body: /SMOKE UNSOLD CAR/ }] });
    console.log('   cleanup done');
  } catch (e) { console.log('   cleanup error:', e.message); }
  await mongoose.disconnect();
}

async function main() {
  const t = tok((await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' })).d?.data);
  check('admin login', !!t);
  if (!t) return;

  // A) BHPH-financed sale → mark unsold.
  const vA = await mkVehicle('A'); const bA = await mkBuyer('A');
  let r = await j('POST', '/bhph/loans', { vehicle: String(vA), buyerLeadId: String(bA), vehicleTitle: 'SMOKE UNSOLD CAR A', salePrice: 20000, downPayment: 4000, interestRatePercent: 12, termMonths: 24, startDate: new Date().toISOString().slice(0, 10) }, t);
  const L = r.d?.data; if (L?._id) loanIds.push(L._id);
  await j('POST', `/bhph/loans/${L._id}/payment`, { amount: 2000, installmentNo: 1 }, t);
  check('A: BHPH loan created + car sold', !!L?.saleId && (await coll('vehicles').findOne({ _id: vA }))?.status === 'sold');
  r = await j('POST', `/inventory/${vA}/mark-unsold`, null, t);
  check('  mark-unsold ok', r.status === 200 || r.status === 201, `status ${r.status}`);
  const vehA = await coll('vehicles').findOne({ _id: vA });
  const loanA = await coll('loans').findOne({ _id: new mongoose.Types.ObjectId(L._id) });
  const saleA = await coll('sales').findOne({ vehicleId: String(vA) });
  const incA = await coll('incomes').countDocuments({ loanId: String(L._id), isDeleted: false });
  check('  car un-sold', vehA?.status === '' && vehA?.soldAt == null);
  check('  loan archived', loanA?.status === 'archived', loanA?.status);
  check('  sale soft-deleted', saleA?.isDeleted === true);
  check('  loan interest income removed', incA === 0);

  // B) Partial cash sale (receivable) → mark unsold.
  const vB = await mkVehicle('B');
  r = await j('POST', '/accounting/sales', { vehicleId: String(vB), vehicleTitle: 'SMOKE UNSOLD CAR B', buyerName: 'Cash Buyer', buyerEmail: 'cashb@test.local', salePrice: 15000, costPrice: 10000, amountPaid: 5000, saleDate: new Date().toISOString().slice(0, 10), paymentMethod: 'cash', paymentStatus: 'partial' }, t);
  const saleB = r.d?.data;
  const rcvB = await coll('receivables').findOne({ saleId: String(saleB._id) });
  check('B: partial sale + receivable created', !!rcvB && rcvB.status === 'open');
  r = await j('POST', `/inventory/${vB}/mark-unsold`, null, t);
  check('  mark-unsold ok', r.status === 200 || r.status === 201, `status ${r.status}`);
  const vehB = await coll('vehicles').findOne({ _id: vB });
  const rcvBafter = await coll('receivables').findOne({ _id: rcvB._id });
  const saleBafter = await coll('sales').findOne({ _id: new mongoose.Types.ObjectId(saleB._id) });
  check('  car un-sold', vehB?.status === '' && vehB?.soldAt == null);
  check('  receivable archived', rcvBafter?.status === 'archived', rcvBafter?.status);
  check('  sale soft-deleted', saleBafter?.isDeleted === true);

  // C) Validation.
  const vC = await mkVehicle('C');
  r = await j('POST', `/inventory/${vC}/mark-unsold`, null, t, false);
  check('C: un-sell a not-sold car → 400', r.status === 400);

  console.log(`\nMark-unsold smoke: ${pass} passed, ${fail} failed`);
}

try { await main(); } finally { await cleanup(); }
process.exit(fail ? 1 : 0);
