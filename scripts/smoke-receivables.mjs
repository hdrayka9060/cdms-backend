/**
 * Receivables smoke — partial/unpaid NON-BHPH sale → auto receivable → payments
 * drive the sale's amountPaid/outstanding → settles. Isolated throwaway vehicle.
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
const vehId = new mongoose.Types.ObjectId();
let saleId, recId;

async function cleanup() {
  try {
    await coll('sales').deleteMany({ vehicleId: String(vehId) });
    await coll('receivables').deleteMany({ vehicleId: String(vehId) });
    await coll('vehicles').deleteOne({ _id: vehId });
    await coll('notifications').deleteMany({ $or: [{ title: /SMOKE RCV CAR/ }, { body: /SMOKE RCV CAR/ }] });
    console.log('   cleanup done');
  } catch (e) { console.log('   cleanup error:', e.message); }
  await mongoose.disconnect();
}

async function main() {
  const t = tok((await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' })).d?.data);
  check('admin login', !!t);
  if (!t) return;

  await coll('vehicles').insertOne({ _id: vehId, title: 'SMOKE RCV CAR', vehicleNumber: 'SMOKE-RCV-1', status: '', isDeleted: false, price: 20000, costPrice: 14000, spends: [], createdAt: new Date(), updatedAt: new Date() });

  // Partial cash sale → should auto-create a receivable.
  let r = await j('POST', '/accounting/sales', {
    vehicleId: String(vehId), vehicleTitle: 'SMOKE RCV CAR', buyerName: 'Rcv Buyer', buyerEmail: 'rcv@test.local',
    salePrice: 20000, costPrice: 14000, discount: 0, amountPaid: 5000, saleDate: new Date().toISOString().slice(0, 10),
    paymentMethod: 'cash', paymentStatus: 'partial',
  }, t);
  saleId = r.d?.data?._id;
  check('partial sale created', r.status === 201 && !!saleId, `status ${r.status}`);

  const rcv0 = await coll('receivables').findOne({ saleId: String(saleId), isDeleted: false });
  recId = rcv0?._id;
  check('receivable auto-created (open)', !!rcv0 && rcv0.status === 'open', `total=${rcv0?.totalAmount} down=${rcv0?.downPayment}`);
  check('  totalAmount = net 20000, down = 5000', rcv0?.totalAmount === 20000 && rcv0?.downPayment === 5000);

  const bySale = (await j('GET', `/receivables/by-sale/${saleId}`, null, t)).d?.data;
  check('  by-sale lookup + computed outstanding 15000', approx(bySale?.outstanding, 15000), `${bySale?.outstanding}`);

  // Record a $5000 payment → sale amountPaid 10000, outstanding 10000, still partial.
  r = await j('POST', `/receivables/${recId}/payment`, { amount: 5000, method: 'cash' }, t);
  check('  payment recorded → receivable outstanding 10000', approx(r.d?.data ? 0 : 1, 0) && (await coll('receivables').findOne({ _id: recId })) != null);
  let sale = await coll('sales').findOne({ _id: new mongoose.Types.ObjectId(saleId) });
  check('  sale.amountPaid bumped to 10000, still partial', approx(sale?.amountPaid, 10000) && sale?.paymentStatus === 'partial', `${sale?.amountPaid}/${sale?.paymentStatus}`);

  // Pay the rest → settled + sale paid.
  r = await j('POST', `/receivables/${recId}/payment`, { amount: 10000, method: 'cash' }, t);
  const rcvFinal = await coll('receivables').findOne({ _id: recId });
  sale = await coll('sales').findOne({ _id: new mongoose.Types.ObjectId(saleId) });
  check('  fully paid → receivable settled', rcvFinal?.status === 'settled', rcvFinal?.status);
  check('  sale → paid, amountPaid 20000', sale?.paymentStatus === 'paid' && approx(sale?.amountPaid, 20000), `${sale?.paymentStatus}/${sale?.amountPaid}`);

  // list shows it under settled filter
  r = await j('GET', '/receivables?status=settled&limit=100', null, t);
  check('  appears in settled list w/ collected/outstanding', (r.d?.data?.data ?? []).some((x) => x._id === String(recId) && x.collected === 20000 && x.outstanding === 0));

  // A fully-paid sale should NOT create a receivable.
  const vehId2 = new mongoose.Types.ObjectId();
  await coll('vehicles').insertOne({ _id: vehId2, title: 'SMOKE RCV CAR2', vehicleNumber: 'SMOKE-RCV-2', status: '', isDeleted: false, price: 15000, costPrice: 10000, spends: [], createdAt: new Date(), updatedAt: new Date() });
  r = await j('POST', '/accounting/sales', { vehicleId: String(vehId2), vehicleTitle: 'SMOKE RCV CAR2', buyerName: 'Paid Buyer', buyerEmail: 'paid@test.local', salePrice: 15000, costPrice: 10000, saleDate: new Date().toISOString().slice(0, 10), paymentMethod: 'cash', paymentStatus: 'paid' }, t);
  const rcvPaid = await coll('receivables').findOne({ vehicleId: String(vehId2) });
  check('paid sale creates NO receivable', !rcvPaid);
  await coll('sales').deleteMany({ vehicleId: String(vehId2) }); await coll('vehicles').deleteOne({ _id: vehId2 });

  console.log(`\nReceivables smoke: ${pass} passed, ${fail} failed`);
}

try { await main(); } finally { await cleanup(); }
process.exit(fail ? 1 : 0);
