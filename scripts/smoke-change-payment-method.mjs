/**
 * Change-payment-method smoke — POST /inventory/:id/change-payment-method
 * cascades across the Sale, BHPH loan, receivable, and financial rollups.
 *   A) cash(paid) → bhph: creates a linked loan, sale becomes bhph/partial.
 *   B) bhph → cash(partial): archives the loan (interest income backed out),
 *      opens a receivable for the outstanding balance.
 *   C) cash(partial) → cash(paid): receivable archived, sale fully paid.
 * Asserts dashboard == accounting revenue/profit parity is preserved throughout.
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
const mkVehicle = async (n) => { const _id = oid(); await coll('vehicles').insertOne({ _id, title: `SMOKE CPM CAR ${n}`, vehicleNumber: `SMOKE-CPM-${n}`, status: '', isDeleted: false, price: 20000, costPrice: 14000, spends: [], createdAt: new Date(), updatedAt: new Date() }); vehIds.push(_id); return _id; };
const mkBuyer = async (n) => { const _id = oid(); await coll('buyer_leads').insertOne({ _id, buyerName: `SMOKE CPM Buyer ${n}`, buyerEmail: `smoke-cpm-${n}@test.local`, buyerPhone: `555-27${n}0`, stage: 'new', isDeleted: false, purchases: [], createdAt: new Date(), updatedAt: new Date() }); buyerIds.push(_id); return _id; };

const parity = async (t, label) => {
  const s = (await j('GET', '/accounting/summary', null, t)).d?.data ?? {};
  const d = (await j('GET', '/dashboard/stats', null, t)).d?.data?.current ?? {};
  const rev = Math.abs((s.totalRevenue ?? s.revenue ?? 0) - (d.totalRevenue ?? d.revenue ?? 0));
  const prof = Math.abs((s.totalProfit ?? s.profit ?? 0) - (d.totalProfit ?? d.profit ?? 0));
  check(`  parity dashboard==accounting (${label})`, rev < 1 && prof < 1, `Δrev=${rev.toFixed(2)} Δprofit=${prof.toFixed(2)}`);
};

async function cleanup() {
  try {
    for (const v of vehIds) {
      const loans = await coll('loans').find({ vehicle: v }).toArray();
      for (const l of loans) await coll('incomes').deleteMany({ loanId: String(l._id) });
      await coll('loans').deleteMany({ vehicle: v });
      const sales = await coll('sales').find({ vehicleId: String(v) }).toArray();
      for (const s of sales) await coll('receivables').deleteMany({ saleId: String(s._id) });
      await coll('sales').deleteMany({ vehicleId: String(v) });
      await coll('leads').deleteMany({ vehicle: v });
      await coll('vehicles').deleteOne({ _id: v });
    }
    for (const b of buyerIds) await coll('buyer_leads').deleteOne({ _id: b });
    await coll('buyer_leads').deleteMany({ buyerEmail: /smoke-cpm/ });
    await coll('notifications').deleteMany({ $or: [{ title: /SMOKE CPM CAR/ }, { body: /SMOKE CPM CAR/ }] });
    console.log('   cleanup done');
  } catch (e) { console.log('   cleanup error:', e.message); }
  await mongoose.disconnect();
}

async function main() {
  const t = tok((await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' })).d?.data);
  check('admin login', !!t);
  if (!t) return;

  const v = await mkVehicle('A'); const b = await mkBuyer('A');
  // Sell for cash, fully paid.
  let r = await j('POST', `/inventory/${v}/mark-sold`, { salePrice: 20000, discount: 0, amountPaid: 20000, saleDate: new Date().toISOString().slice(0, 10), paymentMethod: 'cash', paymentStatus: 'paid', buyerLeadId: String(b) }, t);
  check('sold for cash (paid)', r.status === 201 || r.status === 200, `status ${r.status}`);
  const sale0 = await coll('sales').findOne({ vehicleId: String(v), isDeleted: false });
  check('  sale is cash/paid', sale0?.paymentMethod === 'cash' && sale0?.paymentStatus === 'paid');
  await parity(t, 'after cash sale');

  // ── A) cash → bhph ────────────────────────────────────────────────────────
  r = await j('POST', `/inventory/${v}/change-payment-method`, { paymentMethod: 'bhph', amountPaid: 5000, bhph: { interestRatePercent: 12, termMonths: 24 } }, t);
  check('A: change cash → bhph', r.status === 201 || r.status === 200, `status ${r.status}`);
  const loanA = await coll('loans').findOne({ vehicle: v, isDeleted: false, status: { $ne: 'archived' } });
  check('  BHPH loan created (principal 15000, down 5000)', !!loanA && loanA.principal === 15000 && loanA.downPayment === 5000, `${loanA?.principal}/${loanA?.downPayment}`);
  const saleA = await coll('sales').findOne({ vehicleId: String(v), isDeleted: false });
  check('  sale now bhph/partial (amountPaid 5000)', saleA?.paymentMethod === 'bhph' && saleA?.paymentStatus === 'partial' && Math.abs((saleA?.amountPaid ?? 0) - 5000) < 1, `${saleA?.paymentMethod}/${saleA?.paymentStatus}/${saleA?.amountPaid}`);
  const recA = await coll('receivables').findOne({ saleId: String(saleA._id), status: { $ne: 'archived' } });
  check('  no active receivable (BHPH uses the loan)', !recA);
  await parity(t, 'after → bhph');

  // ── B) bhph → cash (partial) ──────────────────────────────────────────────
  r = await j('POST', `/inventory/${v}/change-payment-method`, { paymentMethod: 'cash', paymentStatus: 'partial', amountPaid: 5000 }, t);
  check('B: change bhph → cash (partial)', r.status === 201 || r.status === 200, `status ${r.status}`);
  const loanB = await coll('loans').findOne({ vehicle: v, isDeleted: false });
  check('  loan archived', loanB?.status === 'archived', loanB?.status);
  const interestB = await coll('incomes').find({ loanId: String(loanB?._id), isDeleted: { $ne: true } }).toArray();
  check('  loan interest income backed out', interestB.length === 0, `rows=${interestB.length}`);
  const saleB = await coll('sales').findOne({ vehicleId: String(v), isDeleted: false });
  check('  sale now cash/partial', saleB?.paymentMethod === 'cash' && saleB?.paymentStatus === 'partial', `${saleB?.paymentMethod}/${saleB?.paymentStatus}`);
  const recB = await coll('receivables').findOne({ saleId: String(saleB._id), status: { $ne: 'archived' } });
  check('  open receivable created (outstanding 15000)', !!recB && Math.abs((recB.totalAmount - (recB.downPayment ?? 0)) - 15000) < 1, `total=${recB?.totalAmount} down=${recB?.downPayment}`);
  await parity(t, 'after → cash partial');

  // ── C) cash partial → cash paid ───────────────────────────────────────────
  r = await j('POST', `/inventory/${v}/change-payment-method`, { paymentMethod: 'cash', paymentStatus: 'paid' }, t);
  check('C: change → cash (paid)', r.status === 201 || r.status === 200, `status ${r.status}`);
  const saleC = await coll('sales').findOne({ vehicleId: String(v), isDeleted: false });
  check('  sale paid (amountPaid = net 20000)', saleC?.paymentStatus === 'paid' && Math.abs((saleC?.amountPaid ?? 0) - 20000) < 1, `${saleC?.paymentStatus}/${saleC?.amountPaid}`);
  const recC = await coll('receivables').findOne({ saleId: String(saleC._id), status: { $ne: 'archived' } });
  check('  receivable archived', !recC);
  await parity(t, 'after → cash paid');

  console.log(`\nChange-payment-method smoke: ${pass} passed, ${fail} failed`);
}

try { await main(); } finally { await cleanup(); }
process.exit(fail ? 1 : 0);
