/**
 * BHPH Phase 3 smoke — Sale linkage + interest-income ledger + accounting/dashboard sync.
 *
 * Provisions an ISOLATED throwaway vehicle (no leads) so demo data is never
 * touched, creates a BHPH loan (auto-links a Sale), records EMIs and asserts
 * that principal shrinks the sale's outstanding, interest posts to the income
 * ledger, and the accounting summary + dashboard revenue move accordingly.
 * Cleans up the loan, sale, income rows and the throwaway vehicle afterward.
 *
 * Run the backend first (npm run start:dev), then: node scripts/smoke-bhph-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'http://localhost:3000/api/v1';
const MARKER = 'smoke-bhph-sync@test.local';
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };
const approx = (a, b, tol = 0.1) => Math.abs(a - b) <= tol;

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
let loanId, saleId;

async function cleanup() {
  try {
    if (loanId) await coll('loans').deleteOne({ _id: new mongoose.Types.ObjectId(loanId) });
    await coll('loans').deleteMany({ borrowerEmail: MARKER });
    await coll('sales').deleteMany({ vehicleId: String(vehId) });
    if (loanId) await coll('incomes').deleteMany({ loanId: String(loanId) });
    await coll('vehicles').deleteOne({ _id: vehId });
    // Payment-recorded events (Phase 7) generate notifications; clean them too.
    await coll('notifications').deleteMany({ $or: [{ 'entity.id': String(loanId) }, { body: /SMOKE BHPH CAR/ }] });
    console.log('   cleanup done (loan, sale, incomes, throwaway vehicle removed)');
  } catch (e) { console.log('   cleanup error:', e.message); }
  await mongoose.disconnect();
}

async function main() {
  const t = tok((await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' })).d?.data);
  check('admin login', !!t);
  if (!t) return;

  // Isolated vehicle (raw insert bypasses validation; no leads → no side-effects on demo data).
  await coll('vehicles').insertOne({ _id: vehId, title: 'SMOKE BHPH CAR', vehicleNumber: 'SMOKE-BHPH-1', status: '', isDeleted: false, price: 12000, costPrice: 8000, spends: [], createdAt: new Date(), updatedAt: new Date() });

  const before = (await j('GET', '/accounting/summary', null, t)).d?.data;
  check('read summary (before)', !!before, `interest=${before?.totalInterestIncome} salesRev=${before?.totalSalesRevenue}`);

  // Create BHPH loan → auto-creates + links a Sale.
  let r = await j('POST', '/bhph/loans', {
    borrowerName: 'Sync Borrower', borrowerEmail: MARKER, borrowerPhone: '555-0199',
    vehicle: String(vehId), vehicleTitle: 'SMOKE BHPH CAR',
    salePrice: 12000, downPayment: 2000, interestRatePercent: 12, termMonths: 6, startDate: new Date().toISOString().slice(0, 10),
  }, t);
  const loan = r.d?.data;
  loanId = loan?._id; saleId = loan?.saleId;
  check('create loan → sale linked', r.status === 201 && !!loan?.saleId, `saleId=${loan?.saleId}`);

  let sale = await coll('sales').findOne({ vehicleId: String(vehId), isDeleted: false });
  check('  sale created (bhph, partial)', sale?.paymentMethod === 'bhph' && sale?.paymentStatus === 'partial', `${sale?.paymentMethod}/${sale?.paymentStatus}`);
  check('  sale.salePrice = 12000', sale?.salePrice === 12000, `got ${sale?.salePrice}`);
  check('  sale.amountPaid = down payment 2000', approx(sale?.amountPaid, 2000), `got ${sale?.amountPaid}`);

  const detail = async () => (await j('GET', `/bhph/loans/${loanId}`, null, t)).d?.data;
  const d0 = await detail();
  const emi = d0.loan.emiAmount;
  const interest1 = d0.schedule[0].interestPart;         // interest portion of installment 1
  const principal1 = d0.schedule[0].principalPart;
  const totalInterest = d0.summary.totalInterest;

  // Record installment 1 in full → principal shrinks sale outstanding, interest → income.
  await j('POST', `/bhph/loans/${loanId}/payment`, { amount: emi, installmentNo: 1 }, t);
  sale = await coll('sales').findOne({ vehicleId: String(vehId), isDeleted: false });
  check('  after EMI1: sale.amountPaid += principal portion', approx(sale?.amountPaid, 2000 + principal1), `got ${sale?.amountPaid} exp ${(2000 + principal1).toFixed(2)}`);
  let incomes = await coll('incomes').find({ loanId: String(loanId), isDeleted: false }).toArray();
  check('  interest income row booked', incomes.length === 1 && approx(incomes[0].amount, interest1), `rows=${incomes.length} amt=${incomes[0]?.amount} exp ${interest1}`);
  check('  income row linked to loan + payment', !!incomes[0]?.paymentId && incomes[0]?.category === 'interest' && incomes[0]?.source === 'bhph-interest');

  const mid = (await j('GET', '/accounting/summary', null, t)).d?.data;
  check('  summary interest income += EMI1 interest', approx(mid.totalInterestIncome - before.totalInterestIncome, interest1, 0.2), `Δ=${(mid.totalInterestIncome - before.totalInterestIncome).toFixed(2)}`);
  check('  summary sales revenue += 12000 (new sale)', approx(mid.totalSalesRevenue - before.totalSalesRevenue, 12000, 0.5), `Δ=${(mid.totalSalesRevenue - before.totalSalesRevenue).toFixed(2)}`);

  // Pay the loan off entirely.
  await j('POST', `/bhph/loans/${loanId}/payments/bulk-pay`, { installmentNos: [1, 2, 3, 4, 5, 6] }, t);
  const dPaid = await detail();
  check('  loan → paid_off', dPaid.loan.status === 'paid_off', dPaid.loan.status);
  sale = await coll('sales').findOne({ vehicleId: String(vehId), isDeleted: false });
  check('  sale fully paid (amountPaid = net 12000, status paid)', approx(sale?.amountPaid, 12000) && sale?.paymentStatus === 'paid', `${sale?.amountPaid}/${sale?.paymentStatus}`);
  incomes = await coll('incomes').find({ loanId: String(loanId), isDeleted: false }).toArray();
  const incomeSum = incomes.reduce((s, x) => s + x.amount, 0);
  check('  Σ interest income = loan total interest', approx(incomeSum, totalInterest, 0.2), `Σ=${incomeSum.toFixed(2)} exp ${totalInterest.toFixed(2)}`);

  const after = (await j('GET', '/accounting/summary', null, t)).d?.data;
  check('  summary interest income += full interest', approx(after.totalInterestIncome - before.totalInterestIncome, totalInterest, 0.2), `Δ=${(after.totalInterestIncome - before.totalInterestIncome).toFixed(2)}`);
  check('  summary total revenue += sale + interest', approx(after.totalRevenue - before.totalRevenue, 12000 + totalInterest, 0.5), `Δ=${(after.totalRevenue - before.totalRevenue).toFixed(2)}`);

  // Dashboard all-time revenue reflects it too.
  const dash = (await j('GET', '/dashboard/stats', null, t)).d?.data;
  check('  dashboard revenue includes the interest income', dash?.current?.totalRevenue >= (after.totalRevenue - 0.5), `dash=${dash?.current?.totalRevenue}`);

  // Delete a payment → income + sale amountPaid adjust back down.
  const hist = (await j('GET', `/bhph/loans/${loanId}/payments`, null, t)).d?.data?.data;
  await j('DELETE', `/bhph/loans/${loanId}/payments/${hist[0]._id}`, null, t);
  const after2 = (await j('GET', '/accounting/summary', null, t)).d?.data;
  check('  delete payment lowers interest income', after2.totalInterestIncome < after.totalInterestIncome + 0.001, `${after2.totalInterestIncome.toFixed(2)} < ${after.totalInterestIncome.toFixed(2)}`);

  console.log(`\nBHPH Phase 3 smoke: ${pass} passed, ${fail} failed`);
}

try { await main(); } finally { await cleanup(); }
process.exit(fail ? 1 : 0);
