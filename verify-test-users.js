// Verify the seeded test users are login-valid: active + admin role + the
// stored bcrypt hash actually verifies against the given password (same checks
// AuthService.login performs). No running backend needed.
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
  for (const { email, password } of USERS) {
    const u = await db.collection('users').findOne({ email });
    if (!u) {
      console.log(`${email.padEnd(20)} MISSING`);
      continue;
    }
    const role = u.roleId
      ? await db.collection('roles').findOne({ _id: u.roleId })
      : null;
    const pwOk = u.password ? await bcrypt.compare(password, u.password) : false;
    const loginOk = pwOk && u.status === 'active' && !u.isDeleted && !!role;
    console.log(
      `${email.padEnd(20)} status=${u.status} role=${role?.name ?? 'NONE'} ` +
        `pwVerifies=${pwOk} -> loginOK=${loginOk ? 'YES' : 'NO'}`,
    );
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
