// Seed 5 active ADMIN test users with known passwords. Idempotent (upsert by
// email). Connects to the same Atlas DB the app uses (MONGODB_URI from .env),
// so these work on local + the EC2 deployment alike.
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
require('dotenv').config();

const USERS = [
  { email: 'test1@email.com', password: 'Test_1@1234' },
  { email: 'test2@email.com', password: 'Test_2@1234' },
  { email: 'test3@email.com', password: 'Test_3@1234' },
  { email: 'test4@email.com', password: 'Test_4@1234' },
  { email: 'test5@email.com', password: 'Test_5@1234' },
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Admin role (seeded on first boot; isSystem). Needed for full permissions.
  const adminRole = await db
    .collection('roles')
    .findOne({ name: 'Admin', isDeleted: { $ne: true } });
  if (!adminRole) {
    throw new Error('Admin role not found — boot the backend once so RolesSeeder runs.');
  }
  console.log(`Admin role _id = ${adminRole._id}`);

  for (let i = 0; i < USERS.length; i++) {
    const { email, password } = USERS[i];
    const hash = await bcrypt.hash(password, 12);
    const now = new Date();
    const res = await db.collection('users').updateOne(
      { email: email.toLowerCase() },
      {
        $set: {
          firstName: 'Test',
          lastName: `User ${i + 1}`,
          email: email.toLowerCase(),
          password: hash,
          roleId: adminRole._id, // ObjectId — Admin (full access)
          status: 'active',
          isDeleted: false,
          // Clear any invite/reset leftovers so login isn't blocked.
          inviteToken: null,
          inviteTokenExpires: null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    const action = res.upsertedCount ? 'created' : 'updated';
    console.log(`  ${email.padEnd(20)} -> ${action} (admin, active)`);
  }

  await mongoose.disconnect();
  console.log('\nDone. All 5 users are active Admins with the given passwords.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
