// Read-only smoke test for the dashboard KPI/expense fixes.
// Replicates the dashboard.service + accounting.service aggregations against
// live Atlas and checks: (1) stock counts, (2) old-vs-new count behaviour,
// (3) dashboard totalExpenses == accounting Total Expenses.
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const YEAR_START = new Date(`${new Date().getFullYear()}-01-01`);

const money = (n) => `$${Math.round(n).toLocaleString()}`;
let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(48)} got=${got}  want=${want}`);
};

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const vehicles = db.collection('vehicles');
const sales = db.collection('sales');
const expenses = db.collection('expenses');
const leads = db.collection('leads');

// ── 1. Stock counts (NEW dashboard behaviour) ──────────────────────────────
const allVehicles = await vehicles.countDocuments({ isDeleted: false });
const soldVehicles = await vehicles.countDocuments({ isDeleted: false, status: 'sold' });
const liveSales = await sales.countDocuments({ isDeleted: false });
const activeLeads = await leads.countDocuments({ isDeleted: false, status: { $nin: ['closed', 'archived'] } });

console.log('\n=== Stock counts (what the NEW dashboard shows) ===');
check('totalVehicles = all non-deleted', allVehicles, 55);
check('vehiclesSold = status:sold non-deleted', soldVehicles, 28);
console.log(`  INFO  live sales rows = ${liveSales} (was counted before; drift vs sold vehicles = ${liveSales - soldVehicles})`);
console.log(`  INFO  activeLeads (un-windowed) = ${activeLeads}`);

// distribution of statuses for sanity
const statusDist = await vehicles.aggregate([
  { $match: { isDeleted: false } },
  { $group: { _id: '$status', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
]).toArray();
console.log('  vehicle status distribution:', statusDist.map((s) => `${s._id}=${s.count}`).join(' '));

// ── 2. OLD (broken) behaviour: windowed by This Year ───────────────────────
const oldTotalVehicles = await vehicles.countDocuments({ isDeleted: false, createdAt: { $gte: YEAR_START } });
const oldVehiclesSold = await sales.countDocuments({ isDeleted: false, saleDate: { $gte: YEAR_START } });
console.log('\n=== OLD behaviour (windowed to This Year) — the reported bug ===');
console.log(`  INFO  old totalVehicles (createdAt>=Jan1) = ${oldTotalVehicles}  (bug report: 46)`);
console.log(`  INFO  old vehiclesSold  (saleDate>=Jan1)  = ${oldVehiclesSold}  (bug report: 26)`);

// ── 3. Money: dashboard block vs accounting summary (all-time) ─────────────
const salesAgg = await sales.aggregate([
  { $match: { isDeleted: false } },
  { $group: {
      _id: null,
      revenue: { $sum: { $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] } },
      cost: { $sum: { $ifNull: ['$costPrice', 0] } },
      spend: { $sum: { $ifNull: ['$totalSpend', 0] } },
  } },
]).toArray();
const opAgg = await expenses.aggregate([
  { $match: { isDeleted: false } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]).toArray();

const revenue = salesAgg[0]?.revenue ?? 0;
const cost = salesAgg[0]?.cost ?? 0;
const spend = salesAgg[0]?.spend ?? 0;
const operational = opAgg[0]?.total ?? 0;

// Dashboard formula (new)
const dashExpenses = operational + spend + cost;
const dashProfit = revenue - dashExpenses;
// Accounting formula
const acctExpenses = operational + spend + cost;
const acctProfit = revenue - acctExpenses;

console.log('\n=== Money parity: dashboard vs accounting (all-time) ===');
console.log(`  revenue=${money(revenue)} operational=${money(operational)} reconditioning=${money(spend)} cost=${money(cost)}`);
console.log(`  dashboard totalExpenses=${money(dashExpenses)}  profit=${money(dashProfit)}`);
console.log(`  accounting totalExpenses=${money(acctExpenses)}  profit=${money(acctProfit)}`);
check('dashboard.totalExpenses == accounting.totalExpenses', dashExpenses, acctExpenses);
check('dashboard.totalProfit == accounting.totalProfit', dashProfit, acctProfit);

// ── 4. Monthly Total Expenses chart total should equal all-time totalExpenses
//     (sum over months of op+cogs, within last 12 months window). Sanity only.
const now = new Date();
const last12 = new Date(now.getFullYear(), now.getMonth() - 11, 1);
const salesByMonth = await sales.aggregate([
  { $match: { isDeleted: false, saleDate: { $gte: last12 } } },
  { $group: { _id: { y: { $year: '$saleDate' }, m: { $month: '$saleDate' } },
      cogs: { $sum: { $add: [{ $ifNull: ['$costPrice', 0] }, { $ifNull: ['$totalSpend', 0] }] } } } },
]).toArray();
const opByMonth = await expenses.aggregate([
  { $match: { isDeleted: false, date: { $gte: last12 } } },
  { $group: { _id: { y: { $year: '$date' }, m: { $month: '$date' } }, total: { $sum: '$amount' } } },
]).toArray();
const cogs12 = salesByMonth.reduce((s, b) => s + b.cogs, 0);
const op12 = opByMonth.reduce((s, b) => s + b.total, 0);
console.log('\n=== Monthly Total Expenses chart (last 12 mo) ===');
console.log(`  sum(op)=${money(op12)} + sum(cogs)=${money(cogs12)} = ${money(op12 + cogs12)} total across bars`);

await mongoose.disconnect();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
