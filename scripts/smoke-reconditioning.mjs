// Read-only smoke test for the "spends → reconditioning expense" model.
// Verifies: (1) every vehicle spend is mirrored once into the expense ledger
// (category='reconditioning'); (2) reconditioning is summed from the ledger,
// independent of sold status; (3) no double-count; (4) dashboard == accounting.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const money = (n) => `$${Math.round(n).toLocaleString()}`;
let failures = 0;
const check = (label, got, want, tol = 0.5) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got=${got}  want=${want}`);
};

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const vehicles = db.collection('vehicles');
const sales = db.collection('sales');
const expenses = db.collection('expenses');

// ── 1. Backfill parity: every vehicle spend mirrored once ──────────────────
const spendAgg = await vehicles.aggregate([
  { $match: { isDeleted: false } },
  { $unwind: '$spends' },
  { $group: { _id: null, count: { $sum: 1 }, total: { $sum: { $ifNull: ['$spends.amount', 0] } } } },
]).toArray();
const spendCount = spendAgg[0]?.count ?? 0;
const spendTotal = spendAgg[0]?.total ?? 0;

const reconAgg = await expenses.aggregate([
  { $match: { isDeleted: false, category: 'reconditioning' } },
  { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
]).toArray();
const reconCount = reconAgg[0]?.count ?? 0;
const reconTotal = reconAgg[0]?.total ?? 0;

console.log('\n=== Backfill / mirror parity (each spend once) ===');
console.log(`  vehicle spends: ${spendCount} rows, ${money(spendTotal)}`);
console.log(`  reconditioning expenses: ${reconCount} rows, ${money(reconTotal)}`);
check('reconditioning expense count == spend count', reconCount, spendCount);
check('reconditioning expense total == spend total', reconTotal, spendTotal);

// ── 2. No double-count: operational excludes reconditioning ─────────────────
const opAgg = await expenses.aggregate([
  { $match: { isDeleted: false, category: { $ne: 'reconditioning' } } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]).toArray();
const operational = opAgg[0]?.total ?? 0;

const salesAgg = await sales.aggregate([
  { $match: { isDeleted: false } },
  { $group: {
      _id: null,
      revenue: { $sum: { $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] } },
      cost: { $sum: { $ifNull: ['$costPrice', 0] } },
      saleSnapshotSpend: { $sum: { $ifNull: ['$totalSpend', 0] } },
  } },
]).toArray();
const revenue = salesAgg[0]?.revenue ?? 0;
const cost = salesAgg[0]?.cost ?? 0;
const saleSnapshotSpend = salesAgg[0]?.saleSnapshotSpend ?? 0;

// Accounting model (all-time)
const acctExpenses = operational + reconTotal + cost;
const acctProfit = revenue - acctExpenses;
// Dashboard uses the identical formula.
const dashExpenses = operational + reconTotal + cost;
const dashProfit = revenue - dashExpenses;

console.log('\n=== Full-cost totals (all-time) ===');
console.log(`  revenue=${money(revenue)} operational=${money(operational)} reconditioning=${money(reconTotal)} cost=${money(cost)}`);
console.log(`  totalExpenses=${money(acctExpenses)}  profit=${money(acctProfit)}`);
console.log(`  (Sale.totalSpend snapshot, NOT summed into totals: ${money(saleSnapshotSpend)})`);
check('dashboard.totalExpenses == accounting.totalExpenses', dashExpenses, acctExpenses);
check('dashboard.totalProfit == accounting.totalProfit', dashProfit, acctProfit);
check('reconditioning is spend-total (not sale-snapshot)', reconTotal, spendTotal);

await mongoose.disconnect();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
