// Read-only: report document counts + a few sample identities per collection.
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const cols = await db.listCollections().toArray();
  const names = cols.map((c) => c.name).sort();

  console.log(`DB: ${db.databaseName}\nCollections: ${names.length}\n`);
  for (const name of names) {
    const total = await db.collection(name).countDocuments({});
    const live = await db.collection(name).countDocuments({ isDeleted: { $ne: true } });
    console.log(`${name.padEnd(28)} total=${String(total).padStart(5)}  live=${String(live).padStart(5)}`);
  }

  console.log('\n--- users ---');
  const users = await db.collection('users').find({}, { projection: { email: 1, firstName: 1, lastName: 1, status: 1, isDeleted: 1 } }).toArray();
  for (const u of users) console.log(`  ${(u.email||'').padEnd(30)} ${(u.firstName||'')} ${(u.lastName||'')}  status=${u.status} deleted=${!!u.isDeleted}`);

  console.log('\n--- roles ---');
  const roles = await db.collection('roles').find({}, { projection: { name: 1, isSystem: 1 } }).toArray();
  for (const r of roles) console.log(`  ${(r.name||'').padEnd(20)} system=${!!r.isSystem}`);

  console.log('\n--- dealer_settings ---');
  const ds = await db.collection('dealer_settings').findOne({});
  console.log(ds ? `  name=${ds.dealershipName} city=${ds.city} country=${ds.country} currency=${ds.currency}` : '  (none)');

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
