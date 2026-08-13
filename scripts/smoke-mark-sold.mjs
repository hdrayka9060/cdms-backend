// Smoke test for "Mark as Sold" (Inventory → Vehicle Details).
// Covers the unified-sale integrations AND the CRM-buyer create/dedup rules.
// Fully self-contained: creates throwaway data, asserts, then deletes it — real
// demo data is untouched.  Run: node scripts/smoke-mark-sold.mjs
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
async function findBuyerByEmail(email) {
  const r = await call('GET', `/crm/buyers?search=${encodeURIComponent(email)}&limit=50`);
  const arr = r.json.data?.data ?? r.json.data ?? [];
  return (Array.isArray(arr) ? arr : []).find((b) => (b.email || b.buyerEmail || '').toLowerCase() === email.toLowerCase());
}

(async () => {
  const login = data(await call('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' }));
  token = login.accessToken || login.access_token || login.token || login.tokens?.accessToken;
  check('login returns a token', !!token);
  if (!token) return;

  const newEmail = `e2e.new.${stamp}@test.local`;
  const existingEmail = `e2e.existing.${stamp}@test.local`;

  try {
    // Pre-create an EXISTING CRM buyer (for the dedup scenarios C + D).
    const existing = data(await call('POST', '/crm/buyers', { buyerName: 'Existing Buyer', buyerEmail: existingEmail, buyerPhone: '5551110000' }));
    trash.buyers.push(existing._id);
    check('seeded an existing CRM buyer', !!existing._id);

    // ── A. New buyer, unique email, with phone → sold + CRM buyer auto-created ──
    const vA = await newVehicle('E2E A — new buyer');
    // an open lead on vA to prove sibling-archive still works
    const leadBuyer = data(await call('POST', '/crm/buyers', { buyerName: 'Lead Buyer', buyerEmail: `e2e.lead.${stamp}@test.local`, buyerPhone: '5552220000' }));
    trash.buyers.push(leadBuyer._id);
    const leadA = data(await call('POST', '/leads', { buyer: leadBuyer._id, vehicle: vA, status: 'new', source: 'website' }));
    trash.leads.push(leadA._id);

    const soldA = await call('POST', `/inventory/${vA}/mark-sold`, {
      buyerName: 'Walk-in Wanda', buyerEmail: newEmail, buyerPhone: '5559998888',
      salePrice: 19000, saleDate: new Date().toISOString().slice(0, 10), paymentMethod: 'cash', paymentStatus: 'paid',
    });
    check('A: mark-sold with new buyer succeeded (201)', soldA.status === 201);
    check('A: vehicle → sold', data(await call('GET', `/inventory/${vA}`)).status === 'sold');
    const createdBuyer = await findBuyerByEmail(newEmail);
    if (createdBuyer) trash.buyers.push(createdBuyer._id);
    check('A: NEW buyer auto-created in CRM', !!createdBuyer, createdBuyer ? `id=${createdBuyer._id}` : 'not found');
    check('A: sibling lead auto-archived', data(await call('GET', `/leads/${leadA._id}`)).status === 'archived');
    const salesA = (await call('GET', '/accounting/sales?limit=200')).json.data?.data ?? [];
    check('A: sales-ledger entry created', salesA.some((s) => String(s.vehicleId) === String(vA)));

    // ── B. New buyer, MISSING phone → 400, no sale ─────────────────────────────
    const vB = await newVehicle('E2E B — no phone');
    const soldB = await call('POST', `/inventory/${vB}/mark-sold`, {
      buyerName: 'No Phone', buyerEmail: `e2e.nophone.${stamp}@test.local`,
      salePrice: 100, saleDate: new Date().toISOString().slice(0, 10),
    }, false);
    check('B: new buyer without phone rejected (400)', soldB.status === 400, 'HTTP ' + soldB.status);
    check('B: vehicle NOT sold', data(await call('GET', `/inventory/${vB}`)).status !== 'sold');

    // ── C. New buyer with an email that ALREADY exists in CRM → 409, no sale ────
    const vC = await newVehicle('E2E C — dup email');
    const soldC = await call('POST', `/inventory/${vC}/mark-sold`, {
      buyerName: 'Dup', buyerEmail: existingEmail, buyerPhone: '5550000000',
      salePrice: 100, saleDate: new Date().toISOString().slice(0, 10),
    }, false);
    check('C: duplicate-email new buyer rejected (409)', soldC.status === 409, 'HTTP ' + soldC.status);
    check('C: vehicle NOT sold (no orphan sale)', data(await call('GET', `/inventory/${vC}`)).status !== 'sold');

    // ── D. Existing buyer picked via buyerLeadId (no phone needed) → 201 ────────
    const vD = await newVehicle('E2E D — existing buyer');
    const soldD = await call('POST', `/inventory/${vD}/mark-sold`, {
      buyerName: 'Existing Buyer', buyerEmail: existingEmail, buyerLeadId: existing._id,
      salePrice: 18000, saleDate: new Date().toISOString().slice(0, 10), paymentMethod: 'cash', paymentStatus: 'paid',
    }, false);
    check('D: mark-sold with linked existing buyer succeeded (201)', soldD.status === 201, 'HTTP ' + soldD.status);
    check('D: vehicle → sold', data(await call('GET', `/inventory/${vD}`)).status === 'sold');

    // ── E. NO buyer at all (walk-in) → 201, sold, no CRM buyer created ─────────
    const buyersBefore = (await call('GET', '/crm/buyers?limit=1')).json.data?.total ?? null;
    const vE = await newVehicle('E2E E — walk-in no buyer');
    const soldE = await call('POST', `/inventory/${vE}/mark-sold`, {
      salePrice: 17000, saleDate: new Date().toISOString().slice(0, 10), paymentMethod: 'cash', paymentStatus: 'paid',
    }, false);
    check('E: walk-in (no buyer) succeeded (201)', soldE.status === 201, 'HTTP ' + soldE.status);
    check('E: vehicle → sold', data(await call('GET', `/inventory/${vE}`)).status === 'sold');
    const salesE = (await call('GET', '/accounting/sales?limit=200')).json.data?.data ?? [];
    const saleE = salesE.find((s) => String(s.vehicleId) === String(vE));
    check('E: walk-in sale recorded with placeholder buyer', !!saleE && /walk-in/i.test(saleE.buyerName || ''), saleE ? `buyerName=${saleE.buyerName}` : 'no sale');
    const buyersAfter = (await call('GET', '/crm/buyers?limit=1')).json.data?.total ?? null;
    check('E: no CRM buyer created for walk-in', buyersBefore === null || buyersAfter === buyersBefore, `before=${buyersBefore} after=${buyersAfter}`);
  } finally {
    for (const id of trash.leads) await call('DELETE', `/leads/${id}`, null, false);
    for (const id of trash.vehicles) await call('DELETE', `/inventory/${id}`, null, false);
    for (const id of trash.buyers) await call('DELETE', `/crm/buyers/${id}`, null, false);
    log(`cleanup: ${trash.vehicles.length} vehicles, ${trash.buyers.length} buyers, ${trash.leads.length} leads deleted`);
  }

  const failed = results.filter((r) => !r.pass);
  log('\n' + (failed.length === 0 ? '🎉 ALL CHECKS PASSED' : `⚠️ ${failed.length} check(s) failed`));
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
