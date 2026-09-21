/**
 * Documents smoke — buyer document management + signable templates:
 *   1) admin uploads a signable template (generated PDF)
 *   2) plain buyer document upload (license)
 *   3) create a signable from the template (pending)
 *   4) sign it → signature stamped into a signed PDF (fetchable), audit meta set
 *   5) list by buyer shows both; void a second signable; delete → soft-deleted
 * HTTP + direct-mongoose flavor; isolated throwaway rows; self-cleans.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'http://localhost:3000/api/v1';
const ORIGIN = 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); };

const authHeaders = (t) => (t ? { Authorization: `Bearer ${t}` } : {});
const j = async (m, p, b, t, expectOk = true) => {
  const res = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...authHeaders(t) }, body: b ? JSON.stringify(b) : undefined });
  let d; try { d = await res.json(); } catch { d = null; }
  if (expectOk && res.status >= 400) console.log(`   ! ${m} ${p} -> ${res.status} ${JSON.stringify(d?.message)}`);
  return { status: res.status, d };
};
const tok = (o) => o?.accessToken || o?.access_token || o?.token || o?.tokens?.accessToken;
const abs = (u) => (/^https?:\/\//i.test(u) ? u : ORIGIN + u);

// 1x1 transparent PNG (valid for pdf-lib embedPng).
const SIG_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const uri = (readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8').match(/^MONGODB_URI=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '');
const { default: mongoose } = await import('mongoose');
await mongoose.connect(uri);
const coll = (c) => mongoose.connection.collection(c);
const oid = () => new mongoose.Types.ObjectId();
const buyerIds = [];

async function cleanup() {
  try {
    for (const b of buyerIds) {
      await coll('buyer_documents').deleteMany({ buyerLeadId: b });
      await coll('buyer_documents').deleteMany({ buyerLeadId: String(b) });
      await coll('buyer_leads').deleteOne({ _id: b });
    }
    await coll('document_templates').deleteMany({ name: /SMOKE-DOC/ });
    await coll('buyer_documents').deleteMany({ title: /SMOKE-DOC/ });
    console.log('   cleanup done');
  } catch (e) { console.log('   cleanup error:', e.message); }
  await mongoose.disconnect();
}

async function main() {
  const login = await j('POST', '/auth/login', { email: 'marcus.bennett@mapleleafmotors.ca', password: 'Welcome@123' });
  const t = tok(login.d?.data);
  check('admin login', !!t);
  if (!t) return;

  // Build a real 1-page PDF for the template + upload.
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const p1 = pdf.addPage([600, 800]);
  p1.drawText('SMOKE-DOC Purchase Agreement — page 1', { x: 50, y: 740, size: 16 });
  const p2 = pdf.addPage([600, 800]);
  p2.drawText('SMOKE-DOC Terms — page 2 (sign here too)', { x: 50, y: 740, size: 16 });
  const pdfBytes = await pdf.save();

  // 1) Create template (multipart).
  const fdT = new FormData();
  fdT.append('name', 'SMOKE-DOC Template');
  fdT.append('category', 'purchase-agreement');
  fdT.append('signatureAnchor', 'bottom-right');
  fdT.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'smoke-doc-template.pdf');
  let res = await fetch(BASE + '/documents/templates', { method: 'POST', headers: authHeaders(t), body: fdT });
  let body = await res.json().catch(() => null);
  const tpl = body?.data;
  check('1. template created', res.status < 400 && !!tpl?._id && !!tpl?.fileUrl, `status ${res.status}`);

  // Buyer to attach documents to.
  const bId = oid();
  await coll('buyer_leads').insertOne({ _id: bId, buyerName: 'SMOKE-DOC Buyer', buyerEmail: `smoke-doc-${Date.now()}@test.local`, buyerPhone: '555-0900', stage: 'new', isDeleted: false, purchases: [], communications: [], history: [], createdAt: new Date(), updatedAt: new Date() });
  buyerIds.push(bId);

  // 2) Plain upload (license).
  const fdU = new FormData();
  fdU.append('buyerLeadId', String(bId));
  fdU.append('title', 'SMOKE-DOC License');
  fdU.append('docType', 'drivers_license');
  fdU.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'license.pdf');
  res = await fetch(BASE + '/documents/upload', { method: 'POST', headers: authHeaders(t), body: fdU });
  body = await res.json().catch(() => null);
  const up = body?.data;
  check('2. plain upload created', res.status < 400 && up?.kind === 'upload' && up?.status === 'uploaded', `status ${res.status}`);

  // 3) Signable from template → pending.
  res = await j('POST', '/documents/from-template', { buyerLeadId: String(bId), templateId: String(tpl._id), title: 'SMOKE-DOC Agreement' }, t);
  const sign1 = res.d?.data;
  check('3. signable created (pending)', sign1?.kind === 'signable' && sign1?.status === 'pending' && String(sign1?.templateId) === String(tpl._id));

  // 4) Sign it → multi-placement across BOTH pages, each with its own signature.
  const placements = [
    { page: 1, x: 0.3, y: 0.85, width: 0.25, signatureImage: SIG_PNG },
    { page: 2, x: 0.7, y: 0.5, width: 0.25, signatureImage: SIG_PNG },
  ];
  res = await j('POST', `/documents/${sign1._id}/sign`, { placements, signerName: 'SMOKE-DOC Buyer' }, t);
  const signed = res.d?.data;
  check('4a. signed status + signedFileUrl (multi-page placement)', signed?.status === 'signed' && !!signed?.signedFileUrl);
  check('4b. signature audit captured', !!signed?.signature?.signedAt && signed?.signature?.signerName === 'SMOKE-DOC Buyer');
  const sres = signed?.signedFileUrl ? await fetch(abs(signed.signedFileUrl)) : { status: 0 };
  const ctype = sres.headers?.get?.('content-type') || '';
  check('4c. signed PDF fetchable', sres.status === 200, `status ${sres.status} ${ctype}`);
  // re-signing a signed doc is rejected
  res = await j('POST', `/documents/${sign1._id}/sign`, { placements: [{ page: 1, x: 0.5, y: 0.5, signatureImage: SIG_PNG }] }, t, false);
  check('4d. re-sign rejected (400)', res.status === 400);

  // 5) List by buyer shows both.
  res = await j('GET', `/documents?buyerLeadId=${bId}`, null, t);
  const list = res.d?.data ?? [];
  check('5a. list shows both docs', Array.isArray(list) && list.length === 2);

  // Void a second signable.
  res = await j('POST', '/documents/from-template', { buyerLeadId: String(bId), templateId: String(tpl._id), title: 'SMOKE-DOC Voidable' }, t);
  const sign2 = res.d?.data;
  res = await j('POST', `/documents/${sign2._id}/void`, null, t);
  check('5b. void signable', res.d?.data?.status === 'void');

  // Delete → soft-deleted.
  res = await j('DELETE', `/documents/${up._id}`, null, t);
  check('5c. delete document', res.d?.data?.deleted === true);
  const afterDel = await coll('buyer_documents').findOne({ _id: new mongoose.Types.ObjectId(up._id) });
  check('5d. delete is soft', afterDel?.isDeleted === true);

  // Template delete.
  res = await j('DELETE', `/documents/templates/${tpl._id}`, null, t);
  check('6. template delete (soft)', res.d?.data?.deleted === true);

  console.log(`\nDocuments smoke: ${pass} passed, ${fail} failed`);
}

try { await main(); } finally { await cleanup(); }
process.exit(fail ? 1 : 0);
