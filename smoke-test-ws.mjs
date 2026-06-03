// WebSocket smoke test (Phase 2): handshake auth + real-time message delivery.
//   • valid JWT connects; a bad token is rejected (auth_error)
//   • a message sent via REST is pushed to the recipient's socket as `message:new`
// Run while the backend is up:  node smoke-test-ws.mjs
import { io } from 'socket.io-client';

const API = 'http://localhost:3000/api/v1';
const WS = 'http://localhost:3000';
const ADMIN = { email: 'smoketest@cdms.local', password: 'SmokeTest1!' };
const TS = Date.now();
const PW = 'WsTest1!';

const pass = (m) => console.log('PASS:', m);
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };

async function jfetch(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const connect = (token) => io(WS, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });

const waitFor = (socket, event, ms = 6000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), ms);
    socket.once(event, (d) => { clearTimeout(t); resolve(d); });
  });

(async () => {
  const adminLogin = await jfetch('/auth/login', { method: 'POST', body: ADMIN });
  const atoken = adminLogin.json?.data?.accessToken;
  if (!atoken) fail('admin login');
  const rolesRes = await jfetch('/roles', { token: atoken });
  const list = rolesRes.json?.data?.data || rolesRes.json?.data || [];
  const roleId = (list.find((r) => r.name === 'Admin') || list[0])?._id;
  if (!roleId) fail('role id');

  async function mkUser(label) {
    const email = `ws_${label}_${TS}@cdms.local`;
    const c = await jfetch('/users', { method: 'POST', token: atoken, body: { firstName: label, lastName: 'Ws', email, password: PW, roleId } });
    const l = await jfetch('/auth/login', { method: 'POST', body: { email, password: PW } });
    return { id: c.json?.data?._id, token: l.json?.data?.accessToken };
  }
  const A = await mkUser('Alice');
  const B = await mkUser('Bob');
  if (!A.id || !A.token || !B.id || !B.token) fail('create users');
  pass(`created A=${A.id} B=${B.id}`);

  // 1) valid connections
  const sockA = connect(A.token);
  const sockB = connect(B.token);
  await Promise.all([waitFor(sockA, 'connect'), waitFor(sockB, 'connect')]);
  pass('both sockets connected with valid JWTs');

  // 2) bad token rejected
  const sockBad = connect('not-a-real-token');
  try {
    await waitFor(sockBad, 'auth_error', 6000);
    pass('bad-token socket rejected (auth_error)');
  } catch (e) {
    fail('bad token was NOT rejected: ' + e.message);
  } finally {
    sockBad.close();
  }

  // 3) real-time delivery: A creates a DM with B; B must receive message:new
  const dm = await jfetch('/messaging/conversations', { method: 'POST', token: A.token, body: { type: 'direct', participantIds: [B.id] } });
  const convId = dm.json?.data?._id;
  if (!convId) fail('DM create');
  const recvP = waitFor(sockB, 'message:new', 8000);
  await jfetch(`/messaging/conversations/${convId}/messages`, { method: 'POST', token: A.token, body: { body: 'realtime hi' } });
  let evt;
  try { evt = await recvP; } catch (e) { fail('B did not receive message:new: ' + e.message); }
  if (evt?.conversationId !== convId || evt?.message?.body !== 'realtime hi') {
    fail('message:new payload mismatch: ' + JSON.stringify(evt));
  }
  pass(`B received message:new in real time ("${evt.message.body}", from ${evt.message.senderName})`);

  sockA.close();
  sockB.close();
  for (const id of [A.id, B.id]) await jfetch(`/users/${id}`, { method: 'DELETE', token: atoken });
  console.log('\n✅ WEBSOCKET SMOKE TESTS PASSED');
  process.exit(0);
})().catch((e) => fail('unexpected: ' + (e?.stack || e)));
