// Smoke test for the notification system (Phase 1 + 1b).
// Validates the full pipeline end-to-end over HTTP for every wired event:
//   1. lead assigned/reassigned  → the new owner (lead.assigned)
//   2. new website lead created  → Leads-viewers (lead.new)
//   3. appointment booked        → the assignee (appointment.booked)
//   4. sale recorded             → accounting + sales managers (sale.recorded)
// Plus unread-count + mark-read. Stable seeded logins (@mapleleafmotors.ca = Welcome@123):
//   marcus.bennett (Admin — all perms, incl. Staff:edit for the role-change test)
//   liam.murphy    (Marketing: Inventory:edit — can Mark Sold; role restored after)
//   aisha.khan     (Support — for the support-ticket test)
// Self-contained: creates throwaway data and best-effort deletes it. NOTE: a stray
// "E2E Ticket" is left behind (no ticket-delete API); Support is hidden, so it's negligible.
// Run: node scripts/smoke-notifications.mjs
const BASE = 'http://localhost:3000/api/v1';
const log = (...a) => console.log(...a);
const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, token, expectOk = true) {
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
const tokenOf = (login) => login.accessToken || login.access_token || login.token || login.tokens?.accessToken;
const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond }); log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

async function waitForNotif(token, pred, tries = 12, gap = 300) {
  for (let i = 0; i < tries; i++) {
    const r = await call('GET', '/notifications?unreadOnly=true&limit=50', null, token, false);
    const hit = (data(r)?.items ?? []).find(pred);
    if (hit) return hit;
    await sleep(gap);
  }
  return null;
}

const trash = { vehicles: [], buyers: [], leads: [], events: [] };

(async () => {
  const mgr = data(await call('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' }));
  const tokenM = tokenOf(mgr);
  check('manager login (marcus)', !!tokenM);
  const tgtLogin = await call('POST', '/auth/login', { email: 'liam.murphy@mapleleafmotors.ca', password: 'Welcome@123' }, null, false);
  const tokenT = tokenOf(data(tgtLogin));
  check('second staff login (liam)', !!tokenT, tgtLogin.status === 200 ? 'liam.murphy' : `HTTP ${tgtLogin.status}`);
  if (!tokenM || !tokenT) return finish();
  const meT = data(await call('GET', '/users/me', null, tokenT));
  const targetId = String(meT._id);
  const targetOrigRole = String(meT.roleId?._id ?? meT.roleId ?? '');
  // A different role to switch the target into (for the role-change test).
  const roles = (data(await call('GET', '/roles', null, tokenM, false)) || []);
  const otherRole = (Array.isArray(roles) ? roles : []).find(
    (r) => !r.isDeleted && String(r._id) !== targetOrigRole);

  try {
    // ── 1. lead assigned → target gets lead.assigned ───────────────────────────
    const buyer = data(await call('POST', '/crm/buyers', { buyerName: 'Notify Buyer', buyerEmail: `e2e.notif.buyer.${stamp}@test.local`, buyerPhone: '5550001111' }, tokenM));
    trash.buyers.push(buyer._id);
    const veh = data(await call('POST', '/inventory', { title: 'E2E Notify Car', company: 'TestCo', model: 'Notif', year: 2021, price: 22000, costPrice: 18000 }, tokenM));
    trash.vehicles.push(veh._id);
    const lead = data(await call('POST', '/leads', { buyer: buyer._id, vehicle: veh._id, status: 'new', source: 'website' }, tokenM));
    trash.leads.push(lead._id);
    await call('PATCH', `/leads/${lead._id}`, { assignedTo: targetId }, tokenM);
    const assigned = await waitForNotif(tokenT, (n) => n.type === 'lead.assigned' && n.entity?.id === String(lead._id));
    check('target received lead.assigned', !!assigned, assigned ? assigned.link : 'not found');

    // ── 2. new website lead → a Leads-viewer (marcus) gets lead.new ────────────
    const inv = data(await call('GET', '/inventory?limit=100', null, tokenM));
    const avail = (inv?.data ?? inv ?? []).find((v) => v.status !== 'sold' && String(v._id) !== String(veh._id)) || { _id: veh._id };
    const inqEmail = `e2e.notif.web.${stamp}@test.local`;
    const inq = await call('POST', '/website/inquiry', { formType: 'contact', name: 'E2E Web Lead', email: inqEmail, phone: '5552223333', vehicleId: String(avail._id), message: 'Interested — smoke' }, null);
    check('public website inquiry accepted (201)', inq.status === 201, 'HTTP ' + inq.status);
    const webNotif = await waitForNotif(tokenM, (n) => n.type === 'lead.new');
    check('Leads-viewer received lead.new', !!webNotif, webNotif ? webNotif.title : 'not found');
    const wb = (await call('GET', `/crm/buyers?search=${encodeURIComponent(inqEmail)}&limit=5`, null, tokenM, false)).json.data?.data ?? [];
    const webBuyer = (Array.isArray(wb) ? wb : []).find((b) => (b.email || b.buyerEmail || '').toLowerCase() === inqEmail);
    if (webBuyer) trash.buyers.push(webBuyer._id);
    if (webNotif?.entity?.id) trash.leads.push(webNotif.entity.id);

    // ── 3. appointment booked for target → target gets appointment.booked ──────
    const start = new Date(Date.now() + 86400000).toISOString();
    const end = new Date(Date.now() + 86400000 + 3600000).toISOString();
    const ev = await call('POST', '/calendar/events', {
      title: 'E2E Test Drive', eventType: 'test_drive', startDateTime: start, endDateTime: end,
      assignedTo: targetId, status: 'scheduled', meetingType: 'physical', customerName: 'Smoke Customer',
    }, tokenM, false);
    check('calendar event created (201)', ev.status === 201, 'HTTP ' + ev.status);
    if (ev.status === 201) trash.events.push(data(ev)._id);
    const appt = await waitForNotif(tokenT, (n) => n.type === 'appointment.booked' && n.entity?.id === String(data(ev)._id));
    check('assignee received appointment.booked', !!appt, appt ? appt.title : 'not found');

    // ── 4. sale recorded (liam marks a car sold) → manager (marcus) gets it ────
    const saleVeh = data(await call('POST', '/inventory', { title: 'E2E Sale Car', company: 'TestCo', model: 'Sale', year: 2020, price: 19000, costPrice: 15000 }, tokenM));
    trash.vehicles.push(saleVeh._id);
    const sold = await call('POST', `/inventory/${saleVeh._id}/mark-sold`, {
      salePrice: 18500, saleDate: new Date().toISOString().slice(0, 10), paymentMethod: 'cash', paymentStatus: 'paid',
    }, tokenT, false);
    check('liam marked the vehicle sold (201)', sold.status === 201, 'HTTP ' + sold.status);
    const saleNotif = await waitForNotif(tokenM, (n) => n.type === 'sale.recorded');
    check('manager received sale.recorded', !!saleNotif, saleNotif ? saleNotif.body : 'not found');

    // ── 5. appointment updated (time change) → assignee gets appointment.updated
    const evU = data(await call('POST', '/calendar/events', {
      title: 'E2E Update Me', eventType: 'test_drive', startDateTime: start, endDateTime: end,
      assignedTo: targetId, status: 'scheduled', meetingType: 'physical',
    }, tokenM));
    trash.events.push(evU._id);
    const ns = new Date(Date.now() + 3 * 86400000).toISOString();
    const ne = new Date(Date.now() + 3 * 86400000 + 3600000).toISOString();
    await call('PATCH', `/calendar/events/${evU._id}`, { startDateTime: ns, endDateTime: ne }, tokenM, false);
    const updated = await waitForNotif(tokenT, (n) => n.type === 'appointment.updated' && n.entity?.id === String(evU._id));
    check('assignee received appointment.updated', !!updated, updated ? updated.body : 'not found');

    // ── 6. appointment cancelled (delete) → assignee gets appointment.cancelled
    const evC = data(await call('POST', '/calendar/events', {
      title: 'E2E Cancel Me', eventType: 'test_drive', startDateTime: start, endDateTime: end,
      assignedTo: targetId, status: 'scheduled', meetingType: 'physical',
    }, tokenM));
    await call('DELETE', `/calendar/events/${evC._id}`, null, tokenM, false);
    const cancelled = await waitForNotif(tokenT, (n) => n.type === 'appointment.cancelled' && n.entity?.id === String(evC._id));
    check('assignee received appointment.cancelled', !!cancelled, cancelled ? cancelled.title : 'not found');

    // ── 7. lead → Negotiation → assignee (rep) gets lead.negotiation ───────────
    await call('PATCH', `/leads/${lead._id}`, { status: 'negotiation' }, tokenM, false);
    const negotiation = await waitForNotif(tokenT, (n) => n.type === 'lead.negotiation' && n.entity?.id === String(lead._id));
    check('assignee received lead.negotiation', !!negotiation, negotiation ? negotiation.title : 'not found');

    // ── 8. new support ticket → support staff get support.ticket-created ───────
    const sup = await call('POST', '/auth/login', { email: 'aisha.khan@mapleleafmotors.ca', password: 'Welcome@123' }, null, false);
    const tokenS = tokenOf(data(sup));
    check('support staff login (aisha)', !!tokenS, sup.status === 200 ? 'aisha.khan' : `HTTP ${sup.status}`);
    if (tokenS) {
      const ticket = await call('POST', '/support/tickets', {
        subject: `E2E Ticket ${stamp}`, description: 'Smoke-test ticket',
        raisedByName: 'Smoke Customer', raisedByEmail: `e2e.ticket.${stamp}@test.local`,
      }, tokenS, false);
      check('support ticket created (201)', ticket.status === 201, 'HTTP ' + ticket.status);
      const ticketNotif = await waitForNotif(tokenS, (n) => n.type === 'support.ticket-created' && n.entity?.id === String(data(ticket)._id));
      check('support staff received support.ticket-created', !!ticketNotif, ticketNotif ? ticketNotif.title : 'not found');
    }

    // ── 9. role changed → the affected user gets user.role-changed ─────────────
    if (otherRole) {
      await call('PATCH', `/users/${targetId}`, { roleId: String(otherRole._id) }, tokenM, false);
      const roleNotif = await waitForNotif(tokenT, (n) => n.type === 'user.role-changed');
      check('affected user received user.role-changed', !!roleNotif, roleNotif ? roleNotif.body?.slice(0, 40) : 'not found');
    } else {
      check('found an alternate role to switch to', false, 'no other role available');
    }

    // ── 10. appointment reminder → assignee gets appointment.reminder ──────────
    const soon = new Date(Date.now() + 30 * 60000).toISOString();
    const soonEnd = new Date(Date.now() + 90 * 60000).toISOString();
    const evR = data(await call('POST', '/calendar/events', {
      title: 'E2E Reminder Me', eventType: 'test_drive', startDateTime: soon, endDateTime: soonEnd,
      assignedTo: targetId, status: 'scheduled', meetingType: 'physical',
    }, tokenM));
    trash.events.push(evR._id);
    const rr = await call('POST', '/calendar/reminders/run', {}, tokenM, false);
    check('run appointment reminders (200)', rr.status === 200 || rr.status === 201, 'HTTP ' + rr.status + ' sent=' + (data(rr).sent));
    const reminder = await waitForNotif(tokenT, (n) => n.type === 'appointment.reminder' && n.entity?.id === String(evR._id));
    check('assignee received appointment.reminder', !!reminder, reminder ? reminder.title : 'not found');

    // ── 11. stale lead → assignee (rep) gets lead.stale (scoped to our lead) ───
    const sl = await call('POST', `/leads/reminders/run?maxIdleDays=0&leadId=${lead._id}`, {}, tokenM, false);
    check('run stale-lead reminders (200)', sl.status === 200 || sl.status === 201, 'HTTP ' + sl.status + ' sent=' + (data(sl).sent));
    const staleNotif = await waitForNotif(tokenT, (n) => n.type === 'lead.stale' && n.entity?.id === String(lead._id));
    check('rep received lead.stale', !!staleNotif, staleNotif ? staleNotif.body?.slice(0, 40) : 'not found');

    // ── mark-read clears the badge ─────────────────────────────────────────────
    await call('PATCH', '/notifications/read', { all: true }, tokenT, false);
    const afterT = data(await call('GET', '/notifications/unread-count', null, tokenT)).total;
    check('mark-all-read clears the target unread count', afterT === 0, `unread=${afterT}`);

    log('ℹ️  Not auto-asserted (trigger not reachable in this harness):');
    log('    • invite-accepted — needs the raw invite token from the email/console to accept.');
    log('    • system.mail-failed — only fires on a REAL send failure (dev-mode mail never fails).');
    log('    • ads.sync-failed — needs a broken ad-account connection + sync (dev-mode has no live ads).');
  } finally {
    // Restore the target's original role (the role-change test switched it).
    if (targetOrigRole) await call('PATCH', `/users/${targetId}`, { roleId: targetOrigRole }, tokenM, false);
    await call('PATCH', '/notifications/read', { all: true }, tokenM, false);
    for (const id of trash.events) await call('DELETE', `/calendar/events/${id}`, null, tokenM, false);
    for (const id of trash.leads) await call('DELETE', `/leads/${id}`, null, tokenM, false);
    for (const id of trash.vehicles) await call('DELETE', `/inventory/${id}`, null, tokenM, false);
    for (const id of trash.buyers) await call('DELETE', `/crm/buyers/${id}`, null, tokenM, false);
    log(`cleanup: ${trash.vehicles.length} vehicles, ${trash.buyers.length} buyers, ${trash.leads.length} leads, ${trash.events.length} events (best-effort)`);
  }
  finish();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

function finish() {
  const failed = results.filter((r) => !r.pass);
  log('\n' + (failed.length === 0 ? '🎉 ALL NOTIFICATION CHECKS PASSED' : `⚠️ ${failed.length} check(s) failed`));
  process.exit(failed.length === 0 ? 0 : 1);
}
