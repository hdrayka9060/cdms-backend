/**
 * BHPH Phase 2 smoke — payment allocation + per-installment state + payment CRUD
 * + server-side overdue/nextDueAt/status.
 *
 * Exercises the live server over HTTP (login = seeded Admin marcus.bennett,
 * Welcome@123), asserting the allocation engine end-to-end, then hard-deletes
 * the test loans it created (marker borrowerEmail) via mongoose so the DB stays
 * clean. Run the backend first (npm run start:dev), then: node scripts/smoke-bhph.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'http://localhost:3000/api/v1';
const MARKER = 'smoke-bhph@test.local';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };
const approx = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

const j = async (m, p, b, t, expectOk = true) => {
  const res = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  let d; try { d = await res.json(); } catch { d = null; }
  if (expectOk && res.status >= 400) console.log(`   ! ${m} ${p} -> ${res.status} ${JSON.stringify(d?.message)}`);
  return { status: res.status, d };
};
const tok = (o) => o?.accessToken || o?.access_token || o?.token || o?.tokens?.accessToken;

// EMI formula mirror for expected-value assertions.
const calcEmi = (P, ratePct, n) => { const r = ratePct / 100 / 12; return r === 0 ? P / n : (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1); };
const stateOf = (schedule, no) => schedule.find((r) => r.installmentNo === no)?.state;

async function cleanup() {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
    const uri = (readFileSync(envPath, 'utf8').match(/^MONGODB_URI=(.+)$/m) || [])[1]?.trim();
    if (!uri) { console.log('   (cleanup skipped — no MONGODB_URI)'); return; }
    const { default: mongoose } = await import('mongoose');
    await mongoose.connect(uri);
    const res = await mongoose.connection.collection('loans').deleteMany({ borrowerEmail: MARKER });
    // Payment-recorded events (Phase 7) generate notifications; clean them too.
    await mongoose.connection.collection('notifications').deleteMany({ body: /Smoke Test Car|Smoke Borrower/ });
    await mongoose.disconnect();
    console.log(`   cleanup: removed ${res.deletedCount} test loan(s)`);
  } catch (e) { console.log('   cleanup error:', e.message); }
}

async function main() {
  const login = await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' });
  const t = tok(login.d?.data || login.d);
  check('admin login', !!t);
  if (!t) return;

  const isoDaysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const base = { borrowerName: 'Smoke Borrower', borrowerEmail: MARKER, borrowerPhone: '555-0100', vehicleTitle: 'Smoke Test Car' };

  // ── Loan A: allocation states + unpay + bulk + paid_off ──────────────────
  const emiA = calcEmi(10000, 12, 6);
  let r = await j('POST', '/bhph/loans', {
    ...base, salePrice: 12000, downPayment: 2000, interestRatePercent: 12, termMonths: 6, startDate: isoDaysAgo(150),
  }, t);
  const A = r.d?.data;
  check('create loan A', r.status === 201 && !!A?._id);
  check('  principal = salePrice − downPayment', A?.principal === 10000, `got ${A?.principal}`);
  check('  EMI solved', approx(A?.emiAmount, emiA), `got ${A?.emiAmount} exp ${emiA.toFixed(2)}`);
  check('  totalPaid starts at 0', A?.totalPaid === 0);
  check('  status active', A?.status === 'active');

  const detailA = async () => (await j('GET', `/bhph/loans/${A._id}`, null, t)).d?.data;
  let da = await detailA();
  check('  schedule has 6 rows', da?.schedule?.length === 6);
  check('  installment 1 overdue (unpaid, past due)', stateOf(da.schedule, 1) === 'overdue', stateOf(da.schedule, 1));
  check('  installment 6 upcoming (future due)', stateOf(da.schedule, 6) === 'upcoming', stateOf(da.schedule, 6));
  check('  overdueCount >= 4', da.summary.overdueCount >= 4, `got ${da.summary.overdueCount}`);
  check('  nextDueAt = installment 1 due', da.summary.nextDueAt?.slice(0, 10) === da.schedule[0].dueDate.slice(0, 10));

  await j('POST', `/bhph/loans/${A._id}/payment`, { amount: emiA, installmentNo: 1 }, t);
  await j('POST', `/bhph/loans/${A._id}/payment`, { amount: emiA / 2, installmentNo: 2 }, t);
  await j('POST', `/bhph/loans/${A._id}/payment`, { amount: emiA * 1.5, installmentNo: 3 }, t);
  da = await detailA();
  check('  inst1 → paid (full EMI)', stateOf(da.schedule, 1) === 'paid', stateOf(da.schedule, 1));
  check('  inst2 → partial (half EMI)', stateOf(da.schedule, 2) === 'partial', stateOf(da.schedule, 2));
  check('  inst2 flagged late (partial + past due)', da.schedule[1].isLate === true);
  check('  inst3 → overpaid (1.5× EMI)', stateOf(da.schedule, 3) === 'overpaid', stateOf(da.schedule, 3));
  check('  nextDueAt advanced to inst2', da.summary.nextDueAt?.slice(0, 10) === da.schedule[1].dueDate.slice(0, 10));

  // Unpay installment 3 (no unallocated pool to refill → truly reverts).
  r = await j('POST', `/bhph/loans/${A._id}/installments/3/unpay`, null, t);
  da = await detailA();
  check('  unpay inst3 → overdue again', stateOf(da.schedule, 3) === 'overdue', stateOf(da.schedule, 3));

  // Bulk-mark everything paid → loan should reach paid_off.
  r = await j('POST', `/bhph/loans/${A._id}/payments/bulk-pay`, { installmentNos: [1, 2, 3, 4, 5, 6] }, t);
  da = await detailA();
  check('  bulk-pay → all installments paid', da.schedule.every((row) => row.state === 'paid' || row.state === 'overpaid'));
  check('  status → paid_off', da.loan.status === 'paid_off', da.loan.status);
  check('  nextDueAt cleared', !da.summary.nextDueAt);

  // Validation: bulk-pay when all paid → 400.
  r = await j('POST', `/bhph/loans/${A._id}/payments/bulk-pay`, { installmentNos: [1] }, t, false);
  check('  bulk-pay already-paid → 400', r.status === 400);

  // ── Loan B: unallocated waterfall + edit + delete ────────────────────────
  const emiB = calcEmi(6000, 0, 3); // 0% → EMI = 2000
  r = await j('POST', '/bhph/loans', { ...base, principal: 6000, interestRatePercent: 0, termMonths: 3, startDate: isoDaysAgo(30) }, t);
  const B = r.d?.data;
  check('create loan B (0% / 3mo)', r.status === 201 && approx(B?.emiAmount, 2000), `emi ${B?.emiAmount}`);
  const detailB = async () => (await j('GET', `/bhph/loans/${B._id}`, null, t)).d?.data;

  // One unallocated payment covering two installments → waterfall.
  r = await j('POST', `/bhph/loans/${B._id}/payment`, { amount: 4000 }, t);
  let db = await detailB();
  check('  unallocated $4000 waterfalls inst1+2 → paid', stateOf(db.schedule, 1) === 'paid' && stateOf(db.schedule, 2) === 'paid');
  check('  inst3 still unpaid', ['overdue', 'upcoming'].includes(stateOf(db.schedule, 3)), stateOf(db.schedule, 3));
  const payId = db.schedule[0].payments[0]?._id || (await j('GET', `/bhph/loans/${B._id}/payments`, null, t)).d?.data?.data?.[0]?._id;

  // Edit the payment down to $2000 → only inst1 covered.
  const histId = (await j('GET', `/bhph/loans/${B._id}/payments`, null, t)).d?.data?.data?.[0]?._id;
  r = await j('PATCH', `/bhph/loans/${B._id}/payments/${histId}`, { amount: 2000 }, t);
  db = await detailB();
  check('  edit payment → $2000 covers only inst1', stateOf(db.schedule, 1) === 'paid');
  check('  inst2 reverts to unpaid', ['overdue', 'upcoming'].includes(stateOf(db.schedule, 2)), stateOf(db.schedule, 2));

  // Payment history pagination shape.
  r = await j('GET', `/bhph/loans/${B._id}/payments?limit=1&page=1`, null, t);
  check('  payments paginated', r.d?.data?.total >= 1 && Array.isArray(r.d?.data?.data));

  // Delete the payment → all unpaid.
  r = await j('DELETE', `/bhph/loans/${B._id}/payments/${histId}`, null, t);
  db = await detailB();
  check('  delete payment → totalPaid back to 0', db.loan.totalPaid === 0, `got ${db.loan.totalPaid}`);

  // Validation: record non-positive amount → 400.
  r = await j('POST', `/bhph/loans/${B._id}/payment`, { amount: 0 }, t, false);
  check('  record amount 0 → 400', r.status === 400);

  console.log(`\nBHPH Phase 2 smoke: ${pass} passed, ${fail} failed`);
}

await main();
await cleanup();
process.exit(fail ? 1 : 0);
