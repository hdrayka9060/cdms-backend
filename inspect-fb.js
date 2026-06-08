// One-off: inspect facebook_connections (catalog id + token presence) and
// marketplace listings so we can see why "no catalog access token" fires.
const mongoose = require('mongoose');
require('dotenv').config();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  console.log('\n=== facebook_connections ===');
  const conns = await db.collection('facebook_connections').find({}).toArray();
  for (const c of conns) {
    console.log({
      _id: String(c._id),
      pageName: c.pageName,
      pageId: c.pageId,
      catalogId: c.catalogId || '(empty)',
      hasCatalogToken: !!(c.catalogAccessTokenEnc && c.catalogAccessTokenEnc.length),
      hasPageToken: !!(c.pageAccessTokenEnc && c.pageAccessTokenEnc.length),
      isDeleted: c.isDeleted,
      status: c.status,
    });
  }

  console.log('\n=== facebook_listings (marketplace_catalog) ===');
  const listings = await db
    .collection('facebook_listings')
    .find({ destinationType: 'marketplace_catalog', isDeleted: false })
    .toArray();
  for (const l of listings) {
    console.log({
      _id: String(l._id),
      vehicleTitle: l.vehicleTitle,
      connection: String(l.connection),
      status: l.status,
      lastError: (l.lastError || '').slice(0, 60),
    });
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
