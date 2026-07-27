// Read-only post-seed verification.
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Types } = mongoose;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const C = (n) => db.collection(n);
  const live = (n, q = {}) => C(n).countDocuments({ isDeleted: { $ne: true }, ...q });

  console.log('── live counts ──');
  for (const n of ['users', 'roles', 'vehicles', 'seller_leads', 'buyer_leads', 'leads', 'sales', 'expenses', 'calendar_events', 'communication_logs', 'loans', 'activities', 'ads_insight_snapshots', 'facebook_listings', 'facebook_comments'])
    console.log(`  ${n.padEnd(22)} ${await live(n)}`);

  console.log('\n── vehicle status mix ──');
  const vs = await C('vehicles').aggregate([{ $match: { isDeleted: { $ne: true } } }, { $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
  console.log('  ' + vs.map((x) => `${x._id}:${x.n}`).join('  '));

  console.log('\n── lead status mix ──');
  const ls = await C('leads').aggregate([{ $match: { isDeleted: { $ne: true } } }, { $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
  console.log('  ' + ls.map((x) => `${x._id}:${x.n}`).join('  '));
  const activeLeads = await live('leads', { status: { $nin: ['closed', 'archived'] } });
  console.log(`  active (not closed/archived): ${activeLeads}`);

  const nowFuture = await C('calendar_events').countDocuments({ isDeleted: { $ne: true }, eventType: 'test_drive', status: 'scheduled', startDateTime: { $gt: new Date() } });
  console.log(`\n  pending test drives (future scheduled): ${nowFuture}`);

  console.log('\n── sample vehicle ──');
  const v = await C('vehicles').findOne({ status: 'sold' });
  console.log(`  ${v.title} | status=${v.status} soldAt=${v.soldAt} cost=${v.costPrice} spend=${v.totalSpend} km=${v.km}`);
  console.log(`  desc: ${v.description}`);
  console.log(`  photo: ${v.photos[0]}  (#${v.photos.length})`);
  console.log(`  vehicle.seller is ObjectId? ${v.seller === null || v.seller instanceof Types.ObjectId}`);

  console.log('\n── sample lead refs (must be ObjectId) ──');
  const l = await C('leads').findOne({ status: 'closed' });
  console.log(`  buyer:${l.buyer?.constructor?.name}  vehicle:${l.vehicle?.constructor?.name}  assignedTo:${l.assignedTo?.constructor?.name}  status:${l.status} log:${l.log.length} timeline:${l.timeline.length}`);

  console.log('\n── accounting totals ──');
  const sales = await C('sales').find({ isDeleted: { $ne: true } }).toArray();
  const rev = sales.reduce((s, x) => s + (x.salePrice - (x.discount || 0)), 0);
  const prof = sales.reduce((s, x) => s + (x.salePrice - (x.discount || 0) - (x.costPrice || 0) - (x.totalSpend || 0)), 0);
  const outstanding = sales.filter((s) => s.paymentStatus !== 'paid').reduce((s, x) => s + ((x.salePrice - (x.discount || 0)) - (x.amountPaid || 0)), 0);
  console.log(`  revenue $${Math.round(rev).toLocaleString('en-US')} | gross profit $${Math.round(prof).toLocaleString('en-US')} | outstanding $${Math.round(outstanding).toLocaleString('en-US')}`);
  const expTotal = (await C('expenses').find({ isDeleted: { $ne: true } }).toArray()).reduce((s, x) => s + x.amount, 0);
  console.log(`  operating expenses (6mo) $${Math.round(expTotal).toLocaleString('en-US')}`);

  console.log('\n── ads (Marketing) ──');
  const snaps = await C('ads_insight_snapshots').find({}).toArray();
  const adSpend = snaps.reduce((s, x) => s + x.spend, 0);
  const adConv = snaps.reduce((s, x) => s + x.conversions, 0);
  const byProv = {};
  snaps.forEach((s) => { byProv[s.provider] = (byProv[s.provider] || 0) + s.spend; });
  console.log(`  total ad spend $${Math.round(adSpend).toLocaleString('en-US')} | conversions ${adConv} | ` + Object.entries(byProv).map(([p, s]) => `${p}:$${Math.round(s).toLocaleString('en-US')}`).join('  '));
  const adConns = await C('ads_connections').find({}).toArray();
  adConns.forEach((c) => console.log(`  conn ${c.provider} status=${c.status} acct=${c.accountId} cur=${c.currency} err="${c.lastError}"`));

  console.log('\n── admin + roles + settings ──');
  const admin = await C('users').findOne({ email: 'hdrayka9060@gmail.com' });
  const adminRole = await C('roles').findOne({ _id: admin.roleId });
  console.log(`  admin role: ${adminRole ? adminRole.name : 'UNRESOLVED'} | status=${admin.status}`);
  const roles = await C('roles').find({}).toArray();
  console.log('  roles: ' + roles.map((r) => `${r.name}${r.isSystem ? '*' : ''}`).join(', '));
  const ds = await C('dealer_settings').findOne({});
  console.log(`  dealership: ${ds.dealershipName}, ${ds.city} ${ds.state} (${ds.currency})`);

  console.log('\n── recent activity feed (top 6) ──');
  const acts = await C('activities').find({}).sort({ createdAt: -1 }).limit(6).toArray();
  acts.forEach((a) => console.log(`  ${a.createdAt.toISOString().slice(0, 10)}  ${a.module}/${a.action}  ${a.label}  · ${a.by}`));

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
