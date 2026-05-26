// Inspect the smoke-test lead's stored shape.
// Tells us exactly what type `vehicle` and `status` are stored as.
const mongoose = require('mongoose');
require('dotenv').config();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Most recent lead in the smoke run — sorted by createdAt desc.
  const lead = await db.collection('leads').findOne(
    {},
    { sort: { createdAt: -1 } },
  );
  if (!lead) { console.log('no leads'); await mongoose.disconnect(); return; }

  console.log('latest lead._id =', lead._id, '(type:', typeof lead._id, lead._id?.constructor?.name + ')');
  console.log('lead.status    =', JSON.stringify(lead.status), '(type:', typeof lead.status + ')');
  console.log('lead.isDeleted =', lead.isDeleted);
  console.log('lead.vehicle   =', lead.vehicle, '(type:', typeof lead.vehicle, lead.vehicle?.constructor?.name + ')');
  console.log('lead.buyer     =', lead.buyer, '(type:', typeof lead.buyer, lead.buyer?.constructor?.name + ')');

  // Now run the exact filter that cleanupSoldArtifacts uses
  const vehicleId = lead.vehicle;
  const asObj = new mongoose.Types.ObjectId(String(vehicleId));
  const asStr = String(vehicleId);

  const matchA = await db.collection('leads').countDocuments({
    vehicle: asObj,
    status: 'closed',
    isDeleted: false,
  });
  const matchB = await db.collection('leads').countDocuments({
    vehicle: asStr,
    status: 'closed',
    isDeleted: false,
  });
  console.log('match with vehicle: ObjectId    =>', matchA);
  console.log('match with vehicle: string      =>', matchB);

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
