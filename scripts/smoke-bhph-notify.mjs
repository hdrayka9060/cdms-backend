/**
 * BHPH Phase 7 smoke — notifications (14a–14d) + reminder cron.
 *   payment-recorded → in-app notification (admin has BHPH:view)
 *   loan-paid-off    → notification on the pay-off flip
 *   reminders/run    → overdue (nextDueAt past) + due-soon (nextDueAt near) notifs
 *
 * Isolated throwaway vehicles; polls the notifications feed; self-cleans
 * (loans, sales, incomes, vehicles, and the notifications it generated).
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const uri = (readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8').match(/^MONGODB_URI=(.+)$/m) || [])[1]?.trim();
const { default: mongoose } = await import('mongoose');
await mongoose.connect(uri);
const coll = (c) => mongoose.connection.collection(c);
const oid = () => new mongoose.Types.ObjectId();
const vehIds = [], loanIds = [], saleIds = [];
const mkVehicle = async (n) => { const _id = oid(); await coll('vehicles').insertOne({ _id, title: `SMOKE P7 CAR ${n}`, vehicleNumber: `SMOKE-P7-${n}`, status: '', isDeleted: false, price: 12000, costPrice: 8000, spends: [], createdAt: new Date(), updatedAt: new Date() }); vehIds.push(_id); return _id; };

// Poll the notifications feed for a type on a given loan entity.
async function waitNotif(t, type, loanId, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const r = await j('GET', '/notifications?limit=50', null, t, false);
    const items = r.d?.data?.items ?? r.d?.data ?? [];
    const hit = items.find((x) => x.type === type && (x.entity?.id === String(loanId) || !loanId));
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}

async function cleanup() {
  try {
    for (const id of loanIds) { await coll('loans').deleteOne({ _id: new mongoose.Types.ObjectId(id) }); await coll('incomes').deleteMany({ loanId: String(id) }); }
    for (const v of vehIds) { await coll('sales').deleteMany({ vehicleId: String(v) }); await coll('vehicles').deleteOne({ _id: v }); }
    await coll('notifications').deleteMany({ 'entity.id': { $in: [...loanIds.map(String), ...saleIds.map(String)] } });
    await coll('notifications').deleteMany({ $or: [{ title: /SMOKE P7/ }, { body: /SMOKE P7/ }] });
    console.log('   cleanup done');
  } catch (e) { console.log('   cleanup error:', e.message); }
  await mongoose.disconnect();
}

async function main() {
  const t = tok((await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' })).d?.data);
  check('admin login (has BHPH:view)', !!t);
  if (!t) return;

  // ── payment-recorded + loan-paid-off ──────────────────────────────────────
  const v1 = await mkVehicle('1');
  let r = await j('POST', '/bhph/loans', { borrowerName: 'P7 Borrower', borrowerEmail: 'smoke-p7@test.local', borrowerPhone: '555-0700', vehicle: String(v1), salePrice: 12000, downPayment: 2000, interestRatePercent: 0, termMonths: 4, startDate: new Date().toISOString().slice(0, 10) }, t);
  const L1 = r.d?.data; if (L1?._id) loanIds.push(L1._id); if (L1?.saleId) saleIds.push(L1.saleId);
  check('create loan L1', r.status === 201 && !!L1?._id, `emi ${L1?.emiAmount}`);

  await j('POST', `/bhph/loans/${L1._id}/payment`, { amount: 500, installmentNo: 1 }, t);
  const nRec = await waitNotif(t, 'bhph.payment-recorded', L1._id);
  check('payment-recorded notification delivered', !!nRec, nRec?.title);

  // Pay it off (0% loan, principal 10000). Bulk-pay all 4 installments.
  await j('POST', `/bhph/loans/${L1._id}/payments/bulk-pay`, { installmentNos: [1, 2, 3, 4] }, t);
  const paidLoan = (await j('GET', `/bhph/loans/${L1._id}`, null, t)).d?.data?.loan;
  check('loan reached paid_off', paidLoan?.status === 'paid_off', paidLoan?.status);
  const nPaid = await waitNotif(t, 'bhph.loan-paid-off', L1._id);
  check('loan-paid-off notification delivered', !!nPaid, nPaid?.title);

  // ── reminders/run: overdue + due-soon (control nextDueAt directly) ─────────
  const v2 = await mkVehicle('2');
  r = await j('POST', '/bhph/loans', { borrowerName: 'P7 Borrower 2', borrowerEmail: 'smoke-p7-2@test.local', borrowerPhone: '555-0702', vehicle: String(v2), salePrice: 12000, downPayment: 2000, interestRatePercent: 12, termMonths: 12, startDate: new Date().toISOString().slice(0, 10) }, t);
  const L2 = r.d?.data; if (L2?._id) loanIds.push(L2._id); if (L2?.saleId) saleIds.push(L2.saleId);
  const L2oid = new mongoose.Types.ObjectId(L2._id);

  // Force OVERDUE: nextDueAt 5 days ago, no prior reminder.
  await coll('loans').updateOne({ _id: L2oid }, { $set: { nextDueAt: new Date(Date.now() - 5 * 86400000), lastReminderAt: null } });
  r = await j('POST', `/bhph/reminders/run?loanId=${L2._id}`, null, t);
  check('reminders/run reports overdue', r.d?.data?.overdue >= 1, JSON.stringify(r.d?.data));
  const nOver = await waitNotif(t, 'bhph.payment-overdue', L2._id);
  check('payment-overdue notification delivered', !!nOver, nOver?.body);

  // Force DUE-SOON: nextDueAt in 2 days, clear the dedupe.
  await coll('loans').updateOne({ _id: L2oid }, { $set: { nextDueAt: new Date(Date.now() + 2 * 86400000), lastReminderAt: null } });
  r = await j('POST', `/bhph/reminders/run?loanId=${L2._id}`, null, t);
  check('reminders/run reports due', r.d?.data?.due >= 1, JSON.stringify(r.d?.data));
  const nDue = await waitNotif(t, 'bhph.payment-due', L2._id);
  check('payment-due notification delivered', !!nDue, nDue?.body);

  // Dedupe: immediate re-run does nothing (lastReminderAt just set).
  r = await j('POST', `/bhph/reminders/run?loanId=${L2._id}`, null, t);
  check('reminder deduped on immediate re-run', (r.d?.data?.due ?? 0) === 0 && (r.d?.data?.overdue ?? 0) === 0, JSON.stringify(r.d?.data));

  console.log(`\nBHPH Phase 7 smoke: ${pass} passed, ${fail} failed`);
}

try { await main(); } finally { await cleanup(); }
process.exit(fail ? 1 : 0);
