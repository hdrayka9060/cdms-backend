/**
 * One-off cleanup: removes the test buyer_leads (and their leads) created while
 * building/verifying the public website inquiry endpoint. Matches ONLY the
 * exact throwaway emails used during development — nothing else is touched.
 *
 * Usage:  node scripts/cleanup-website-test-leads.mjs
 */
import { readFileSync } from 'fs';
import mongoose from 'mongoose';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const uri = (env.match(/^MONGODB_URI=(.+)$/m) || [])[1]?.trim();
if (!uri) {
  console.error('MONGODB_URI not found in .env');
  process.exit(1);
}

const TEST_EMAILS = [
  'phase2.test@example.com',
  'booking.test@example.com',
  'smoke.novehicle@example.com',
  'smoke.vehicle@example.com',
];

await mongoose.connect(uri);
const db = mongoose.connection.db;

const buyers = await db.collection('buyer_leads').find({ buyerEmail: { $in: TEST_EMAILS } }).toArray();
console.log('Matched test buyers:', buyers.map((b) => `${b.buyerName} <${b.buyerEmail}>`));

const buyerIds = buyers.map((b) => b._id);
const leadRes = buyerIds.length
  ? await db.collection('leads').deleteMany({ buyer: { $in: buyerIds } })
  : { deletedCount: 0 };
const buyerRes = buyerIds.length
  ? await db.collection('buyer_leads').deleteMany({ _id: { $in: buyerIds } })
  : { deletedCount: 0 };

console.log(`Deleted ${leadRes.deletedCount} lead(s) and ${buyerRes.deletedCount} buyer(s).`);
await mongoose.disconnect();
