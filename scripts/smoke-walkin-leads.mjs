// Smoke test for walk-in leads + buyer-on-mark-sold + assign-buyer-later.
// Self-contained: creates throwaway data, asserts, deletes it. Real demo data
// untouched.  Run: node scripts/smoke-walkin-leads.mjs
const BASE = 'http://localhost:3000/api/v1';
const log = (...a) => console.log(...a);
const stamp = Date.now();
let token = '';

async function call(method, path, body, expectOk = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (expectOk && !res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return { status: res.status, json };
}
const data = (r) => r.json.data ?? r.json;
const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };
const trash = { vehicles: [], buyers: [], leads: [] };
async function newVehicle(title) {
  const v = data(await call('POST', '/inventory', { title, company: 'TestCo', model: 'Probe', year: 2020, price: 20000, costPrice: 15000 }));
  trash.vehicles.push(v._id); return v._id;
}
const salesFor = async (vid) => {
  const arr = (await call('GET', '/accounting/sales?limit=200')).json.data?.data ?? [];
  return arr.find((s) => String(s.vehicleId) === String(vid));
};

(async () => {
  const login = data(await call('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' }));
  token = login.accessToken || login.access_token || login.token || login.tokens?.accessToken;
  check('login', !!token); if (!token) return;

  try {
    // ── 1. Mark-sold (walk-in) creates a CLOSED walk-in lead + sold-buyer=Walk-in ──
    const v1 = await newVehicle('E2E walkin mark-sold');
    await call('POST', `/inventory/${v1}/mark-sold`, { salePrice: 19000, saleDate: new Date().toISOString().slice(0, 10) });
    const closed1 = (await call('GET', `/leads?vehicle=${v1}&status=closed&limit=5`)).json.data?.data ?? [];
    trash.leads.push(...closed1.map((l) => l._id));
    check('1: mark-sold created a closed lead', closed1.length === 1, `count=${closed1.length}`);
    check('1: that lead is walk-in (no buyer)', closed1[0] && !closed1[0].buyer);
    check('1: lead source = walk_in', closed1[0]?.source === 'walk_in', closed1[0]?.source);
    const sb1 = data(await call('GET', `/inventory/${v1}/sold-buyer`));
    check('1: sold-buyer isWalkIn + name "Walk-in"', sb1?.isWalkIn === true && sb1?.buyerName === 'Walk-in');

    // ── 2. Archiving that closed lead un-sells the car + removes the sale ──
    check('2: sale exists before archive', !!(await salesFor(v1)));
    await call('PATCH', `/leads/${closed1[0]._id}`, { status: 'archived' });
    check('2: vehicle back to available (not sold)', data(await call('GET', `/inventory/${v1}`)).status !== 'sold');
    check('2: sale removed from ledger', !(await salesFor(v1)));

    // ── 3. Create a walk-in lead (no buyer) directly ──
    const v3 = await newVehicle('E2E walkin lead');
    const wl = data(await call('POST', '/leads', { vehicle: v3, source: 'walk_in' }));
    trash.leads.push(wl._id);
    check('3: walk-in lead created without buyer', !!wl._id && !wl.buyer);

    // ── 4. Create a lead with a NEW buyer inline (dedup) ──
    const v4 = await newVehicle('E2E new-buyer lead');
    const email = `e2e.leadbuyer.${stamp}@test.local`;
    const nl = data(await call('POST', '/leads', { vehicle: v4, source: 'referral', newBuyerName: 'Inline Buyer', newBuyerEmail: email, newBuyerPhone: '5551234567' }));
    trash.leads.push(nl._id);
    check('4: lead created + new buyer attached', !!nl._id && !!nl.buyer);
    const createdBuyerId = typeof nl.buyer === 'object' ? nl.buyer._id ?? nl.buyer.id : nl.buyer;
    if (createdBuyerId) trash.buyers.push(createdBuyerId);
    const v4b = await newVehicle('E2E dup-email lead');
    const dup = await call('POST', '/leads', { vehicle: v4b, source: 'referral', newBuyerName: 'Dup', newBuyerEmail: email, newBuyerPhone: '5550000000' }, false);
    check('4: duplicate new-buyer email rejected (409)', dup.status === 409, 'HTTP ' + dup.status);

    // ── 5. Assign a buyer LATER to a walk-in lead ──
    const assignEmail = `e2e.assign.${stamp}@test.local`;
    const assigned = data(await call('POST', `/leads/${wl._id}/assign-buyer`, { newBuyerName: 'Assigned Later', newBuyerEmail: assignEmail, newBuyerPhone: '5559876543' }));
    check('5: buyer assigned to walk-in lead', !!assigned.buyer);
    const assignedBuyerId = typeof assigned.buyer === 'object' ? assigned.buyer._id ?? assigned.buyer.id : assigned.buyer;
    if (assignedBuyerId) trash.buyers.push(assignedBuyerId);
    const reassign = await call('POST', `/leads/${wl._id}/assign-buyer`, { newBuyerName: 'X', newBuyerEmail: `x.${stamp}@test.local`, newBuyerPhone: '5551112222' }, false);
    check('5: re-assign rejected (lead already has buyer, 409)', reassign.status === 409, 'HTTP ' + reassign.status);

    // ── 6. Assign a buyer to a CLOSED walk-in sale → Sale row updates ──
    const v6 = await newVehicle('E2E closed walk-in assign');
    await call('POST', `/inventory/${v6}/mark-sold`, { salePrice: 21000, saleDate: new Date().toISOString().slice(0, 10) });
    const sb6 = data(await call('GET', `/inventory/${v6}/sold-buyer`));
    trash.leads.push(sb6.leadId);
    const buyer6Email = `e2e.closedassign.${stamp}@test.local`;
    await call('POST', `/leads/${sb6.leadId}/assign-buyer`, { newBuyerName: 'Post Sale Buyer', newBuyerEmail: buyer6Email, newBuyerPhone: '5553334444' });
    const sale6 = await salesFor(v6);
    check('6: assigning buyer updated the Sale buyerName', sale6 && /Post Sale Buyer/.test(sale6.buyerName || ''), sale6 ? sale6.buyerName : 'no sale');
    const sb6after = data(await call('GET', `/inventory/${v6}/sold-buyer`));
    if (sb6after?.buyerId) trash.buyers.push(sb6after.buyerId);
    check('6: sold-buyer now shows the assigned buyer', sb6after?.isWalkIn === false && /Post Sale Buyer/.test(sb6after?.buyerName || ''));
  } finally {
    for (const id of trash.leads) if (id) await call('DELETE', `/leads/${id}`, null, false);
    for (const id of trash.vehicles) await call('DELETE', `/inventory/${id}`, null, false);
    for (const id of trash.buyers) if (id) await call('DELETE', `/crm/buyers/${id}`, null, false);
    log(`cleanup: ${trash.vehicles.length} vehicles, ${trash.buyers.length} buyers, ${trash.leads.length} leads`);
  }
  const failed = results.filter((r) => !r.pass);
  log('\n' + (failed.length === 0 ? '🎉 ALL CHECKS PASSED' : `⚠️ ${failed.length} failed`));
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
