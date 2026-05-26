// Audit how cross-collection refs are actually stored, vs what the schemas say.
const mongoose = require('mongoose');
require('dotenv').config();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const report = async (col, fields) => {
    const doc = await db.collection(col).findOne({}, { sort: { createdAt: -1 } });
    if (!doc) { console.log(`${col}: no docs`); return; }
    console.log(`\n--- ${col} (_id=${doc._id}) ---`);
    for (const f of fields) {
      const v = doc[f];
      const t = v?.constructor?.name ?? typeof v;
      console.log(`  ${f.padEnd(15)} = ${v}  (${t})`);
    }
  };

  await report('leads', ['buyer', 'vehicle', 'assignedTo']);
  await report('vehicles', ['addedBy', 'seller']);
  await report('buyer_leads', ['assignedTo']);
  await report('sales', ['vehicleId']);
  await report('users', ['roleId']);

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
