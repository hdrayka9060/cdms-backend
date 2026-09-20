/**
 * BHPH Phase 5 smoke — loan lifecycle: update / close / archive.
 *   L1: create → pay → UPDATE (price+term re-solve, sale re-sync) → CLOSE (kept)
 *   L2: create → pay → ARCHIVE (sale reversed, car un-sold, income removed)
 *   + validation: mutate/archive an archived loan → 400.
 *
 * Isolated throwaway vehicles; reads sales/incomes/vehicles directly; self-cleans.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'http://localhost:3000/api/v1';
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };
const approx = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
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
const mkVehicle = async (n) => { const _id = oid(); await coll('vehicles').insertOne({ _id, title: `SMOKE P5 CAR ${n}`, vehicleNumber: `SMOKE-P5-${n}`, status: '', isDeleted: false, price: 12000, costPrice: 8000, spends: [], createdAt: new Date(), updatedAt: new Date() }); vehIds.push(_id); return _id; };

async function cleanup() {
  try {
    for (const id of loanIds) { await coll('loans').deleteOne({ _id: new mongoose.Types.ObjectId(id) }); await coll('incomes').deleteMany({ loanId: String(id) }); }
    await coll('loans').deleteMany({ borrowerEmail: /smoke-p5/ });
    for (const v of vehIds) { await coll('sales').deleteMany({ vehicleId: String(v) }); await coll('vehicles').deleteOne({ _id: v }); }
    await coll('notifications').deleteMany({ $or: [{ title: /SMOKE P5 CAR/ }, { body: /SMOKE P5 CAR/ }] });
    console.log('   cleanup done');
  } catch (e) { console.log('   cleanup error:', e.message); }
  await mongoose.disconnect();
}

async function main() {
  const t = tok((await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' })).d?.data);
  check('admin login', !!t);
  if (!t) return;
  const base = { borrowerName: 'P5 Borrower', borrowerPhone: '555-0500' };
  const detail = async (id) => (await j('GET', `/bhph/loans/${id}`, null, t)).d?.data;

  // ── L1: create → pay → UPDATE → CLOSE ─────────────────────────────────────
  const v1 = await mkVehicle('1');
  let r = await j('POST', '/bhph/loans', { ...base, borrowerEmail: 'smoke-p5-a@test.local', vehicle: String(v1), salePrice: 12000, downPayment: 2000, interestRatePercent: 12, termMonths: 6, startDate: new Date().toISOString().slice(0, 10) }, t);
  const L1 = r.d?.data; if (L1?._id) loanIds.push(L1._id);
  check('L1 create + sale linked', r.status === 201 && !!L1?.saleId);
  let veh1 = await coll('vehicles').findOne({ _id: v1 });
  check('  vehicle flipped to sold', veh1?.status === 'sold');
  await j('POST', `/bhph/loans/${L1._id}/payment`, { amount: 2000, installmentNo: 1 }, t);

  // UPDATE: raise price to 15000, extend term to 12.
  r = await j('PATCH', `/bhph/loans/${L1._id}`, { salePrice: 15000, termMonths: 12 }, t);
  const upd = r.d?.data;
  check('L1 update ok', r.status === 200 || r.status === 201);
  check('  price + principal recomputed (15000 / 13000)', upd?.salePrice === 15000 && upd?.principal === 13000, `${upd?.salePrice}/${upd?.principal}`);
  check('  term updated to 12', upd?.termMonths === 12);
  const sale1 = await coll('sales').findOne({ vehicleId: String(v1), isDeleted: false });
  check('  linked sale salePrice re-synced to 15000', sale1?.salePrice === 15000, `${sale1?.salePrice}`);

  // CLOSE: sale + income kept.
  r = await j('POST', `/bhph/loans/${L1._id}/close`, null, t);
  check('L1 close → status closed', r.d?.data?.status === 'closed', r.d?.data?.status);
  const sale1b = await coll('sales').findOne({ vehicleId: String(v1) });
  const inc1 = await coll('incomes').countDocuments({ loanId: String(L1._id), isDeleted: false });
  check('  close keeps sale + income booked', sale1b && sale1b.isDeleted === false && inc1 >= 1, `saleDeleted=${sale1b?.isDeleted} income=${inc1}`);

  // ── L2: create → pay → ARCHIVE ────────────────────────────────────────────
  const v2 = await mkVehicle('2');
  r = await j('POST', '/bhph/loans', { ...base, borrowerEmail: 'smoke-p5-b@test.local', vehicle: String(v2), salePrice: 12000, downPayment: 2000, interestRatePercent: 12, termMonths: 6, startDate: new Date().toISOString().slice(0, 10) }, t);
  const L2 = r.d?.data; if (L2?._id) loanIds.push(L2._id);
  await j('POST', `/bhph/loans/${L2._id}/payment`, { amount: 2000, installmentNo: 1 }, t);
  const summaryPre = (await j('GET', '/accounting/summary', null, t)).d?.data;
  const incPre = await coll('incomes').countDocuments({ loanId: String(L2._id), isDeleted: false });
  check('L2 create + pay (income booked)', !!L2?.saleId && incPre >= 1, `income=${incPre}`);

  r = await j('POST', `/bhph/loans/${L2._id}/archive`, null, t);
  check('L2 archive ok', r.status === 200 || r.status === 201);
  check('  loan status archived', r.d?.data?.status === 'archived', r.d?.data?.status);
  const veh2 = await coll('vehicles').findOne({ _id: v2 });
  check('  car un-sold (status cleared, soldAt/soldDate removed)', veh2?.status === '' && veh2?.soldAt == null && veh2?.soldDate == null, `status='${veh2?.status}' soldAt=${veh2?.soldAt}`);
  const sale2 = await coll('sales').findOne({ vehicleId: String(v2) });
  check('  linked sale soft-deleted', sale2?.isDeleted === true);
  const inc2 = await coll('incomes').countDocuments({ loanId: String(L2._id), isDeleted: false });
  check('  interest income removed', inc2 === 0, `income=${inc2}`);
  const listed = (await j('GET', '/bhph/loans?limit=100', null, t)).d?.data?.data ?? [];
  check('  archived loan excluded from default list', !listed.some((l) => l._id === L2._id));
  const summaryPost = (await j('GET', '/accounting/summary', null, t)).d?.data;
  check('  financials backed out (revenue + interest fell)', summaryPost.totalSalesRevenue < summaryPre.totalSalesRevenue && summaryPost.totalInterestIncome < summaryPre.totalInterestIncome + 0.001,
    `revΔ=${(summaryPost.totalSalesRevenue - summaryPre.totalSalesRevenue).toFixed(0)}`);

  // ── Validation on archived loan ───────────────────────────────────────────
  r = await j('PATCH', `/bhph/loans/${L2._id}`, { termMonths: 24 }, t, false);
  check('  update archived → 400', r.status === 400);
  r = await j('POST', `/bhph/loans/${L2._id}/archive`, null, t, false);
  check('  re-archive → 400', r.status === 400);
  r = await j('POST', `/bhph/loans/${L2._id}/payment`, { amount: 100 }, t, false);
  check('  pay archived → 400', r.status === 400);

  console.log(`\nBHPH Phase 5 smoke: ${pass} passed, ${fail} failed`);
}

try { await main(); } finally { await cleanup(); }
process.exit(fail ? 1 : 0);
