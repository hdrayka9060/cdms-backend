/* eslint-disable */
/**
 * CDMS realistic demo seed.
 *
 * Wipes test/smoke business data and seeds a coherent ~6-month operating history
 * for "Maple Leaf Motors" (Mississauga, ON · CAD). Preserves the real admin
 * login + the 5 system roles + the live Facebook/Ads connections (their OAuth
 * tokens). Run:  node seed/seed.js
 *
 * Inserts use the raw driver, so every doc sets isDeleted/createdAt/updatedAt
 * explicitly (Mongoose defaults + timestamps do NOT apply to raw inserts).
 */
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Types } = mongoose;
const oid = () => new Types.ObjectId();

// ───────────────────────── deterministic RNG ─────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260623);
const rnd = () => rand();
const int = (lo, hi) => Math.floor(rnd() * (hi - lo + 1)) + lo;
const flo = (lo, hi) => rnd() * (hi - lo) + lo;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const pickN = (arr, n) => shuffle(arr).slice(0, Math.min(n, arr.length));
const round = (n, step = 1) => Math.round(n / step) * step;
const weighted = (pairs) => { // [[val,w],...]
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[0][0];
};

// ───────────────────────── time helpers ─────────────────────────
const NOW = new Date();
const DAY = 86400000;
const WINDOW = 195; // days of history
const daysAgo = (d) => new Date(NOW.getTime() - d * DAY);
const dateBetween = (olderDays, newerDays = 0) => daysAgo(int(newerDays, olderDays));
const addDays = (date, d) => new Date(date.getTime() + d * DAY);
const clampPast = (date) => (date.getTime() > NOW.getTime() ? new Date(NOW.getTime() - int(1, 4) * DAY) : date);
const ymd = (d) => d.toISOString().slice(0, 10);
const at = (date, h, m = 0) => { const x = new Date(date); x.setHours(h, m, 0, 0); return x; };

// ───────────────────────── reference pools ─────────────────────────
const IMG_IDS = [
  '1503376780353-7e6692767b70', '1552519507-da3b142c6e3d', '1605559424843-9e4c228bf1c2',
  '1494976388531-d1058494cdd8', '1583121274602-3e2820c69888', '1568605117036-5fe5e7bab0b7',
  '1533473359331-0135ef1b58bf', '1502877338535-766e1452684a', '1606664515524-ed2f786a0bd6',
  '1611016186353-9af58c69a533', '1606152421802-db97b9c7a11b', '1580273916550-e323be2ae537',
  '1580414057403-c5f451f30e1c', '1612825173281-9a193378527e', '1568844293986-8d0400bd4745',
  '1532581140115-3e355d1ed1de', '1626668893632-6f3a4466d22f', '1542362567-b07e54358753',
  '1493238792000-8113da705763', '1617814076367-b759c7d7e738', '1614162692292-7ac56d7f7f1e',
  '1631295868223-63265b40d9e4', '1619767886558-efdc259cde1a', '1494905998402-395d579af36f',
];
const img = (id) => `https://images.unsplash.com/photo-${id}?w=1280&q=80&auto=format&fit=crop`;
const PHOTOS = IMG_IDS.map(img);
const vehiclePhotos = (i) => {
  const n = int(3, 5);
  const out = [];
  for (let k = 0; k < n; k++) out.push(PHOTOS[(i * 3 + k) % PHOTOS.length]);
  return out;
};

const FIRST = ['Liam', 'Olivia', 'Noah', 'Emma', 'Jackson', 'Ava', 'Lucas', 'Sophia', 'Aiden', 'Isabella', 'Ethan', 'Mia', 'Logan', 'Charlotte', 'Mason', 'Amelia', 'Arjun', 'Priya', 'Wei', 'Mei', 'Mohammed', 'Fatima', 'Carlos', 'Sofia', 'Daniel', 'Hannah', 'Ryan', 'Grace', 'Nathan', 'Chloe', 'Samuel', 'Zoe', 'Jacob', 'Lily', 'Benjamin', 'Aria', 'William', 'Maya', 'Alexander', 'Layla', 'Diego', 'Ananya', 'Hassan', 'Aisha', 'Kwame', 'Nia', 'Marcus', 'Elena', 'Omar', 'Yuki'];
const LAST = ['Smith', 'Brown', 'Tremblay', 'Roy', 'Wong', 'Chen', 'Singh', 'Patel', 'Nguyen', 'Tran', 'Garcia', 'Martinez', 'Johnson', 'Williams', 'Lee', 'Kim', 'Khan', 'Ali', 'MacDonald', 'Gauthier', 'Cote', 'Brar', 'Gill', 'Sharma', 'Kumar', 'Ahmed', 'Lopez', 'Rossi', 'Mueller', 'OBrien', 'Taylor', 'Wilson', 'Anderson', 'Thomas', 'White', 'Park', 'Liu', 'Zhang', 'Reyes', 'Bennett', 'Carter', 'Murphy', 'Bouchard', 'Dubois', 'Fortin'];
const EMAIL_DOMAINS = ['gmail.com', 'outlook.com', 'yahoo.ca', 'hotmail.com', 'icloud.com'];
const CITIES = ['Mississauga', 'Brampton', 'Toronto', 'Oakville', 'Milton', 'Vaughan', 'Markham', 'Burlington', 'Hamilton', 'Etobicoke', 'Scarborough', 'Oshawa', 'Richmond Hill', 'Ajax', 'Pickering'];
const STREETS = ['Hurontario St', 'Dundas St W', 'Lakeshore Rd E', 'Eglinton Ave W', 'Burnhamthorpe Rd', 'Derry Rd', 'Britannia Rd', 'Winston Churchill Blvd', 'Erin Mills Pkwy', 'Queen St E', 'Main St N', 'King St W', 'Bloor St W', 'Mavis Rd', 'Cawthra Rd'];
const AREA_CODES = ['416', '647', '437', '905', '289', '365'];
const COLORS = ['Pearl White', 'Midnight Black', 'Metallic Silver', 'Gunmetal Grey', 'Deep Blue', 'Racing Red', 'Forest Green', 'Bronze Metallic', 'Champagne', 'Graphite'];
const LETTERS = 'ABCEGHJKLMNPRSTVXY';
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

const phone = () => `(${pick(AREA_CODES)}) ${int(200, 999)}-${String(int(0, 9999)).padStart(4, '0')}`;
const postal = () => `${pick(LETTERS)}${int(0, 9)}${pick(LETTERS)} ${int(0, 9)}${pick(LETTERS)}${int(0, 9)}`;
const vin = () => Array.from({ length: 17 }, () => VIN_CHARS[Math.floor(rnd() * VIN_CHARS.length)]).join('');
const emailFor = (f, l, i) => `${f}.${l}${chance(0.5) ? i : ''}`.toLowerCase().replace(/[^a-z0-9.]/g, '') + '@' + pick(EMAIL_DOMAINS);
const fullName = (p) => `${p.first} ${p.last}`;

// make/model catalog (used-car dealer mix, CAD)
const CATALOG = [
  { co: 'Honda', md: 'Civic', body: 'Sedan', fuel: 'petrol', tr: 'cvt', lo: 19000, hi: 29000, trims: ['LX', 'EX', 'Sport', 'Touring'] },
  { co: 'Honda', md: 'CR-V', body: 'SUV', fuel: 'petrol', tr: 'cvt', lo: 28000, hi: 42000, trims: ['LX', 'EX', 'EX-L', 'Touring'] },
  { co: 'Honda', md: 'Accord', body: 'Sedan', fuel: 'petrol', tr: 'cvt', lo: 26000, hi: 38000, trims: ['Sport', 'EX-L', 'Touring'] },
  { co: 'Toyota', md: 'Corolla', body: 'Sedan', fuel: 'petrol', tr: 'cvt', lo: 19000, hi: 27000, trims: ['LE', 'SE', 'XSE'] },
  { co: 'Toyota', md: 'RAV4', body: 'SUV', fuel: 'hybrid', tr: 'automatic', lo: 30000, hi: 44000, trims: ['LE', 'XLE', 'Trail', 'Limited'] },
  { co: 'Toyota', md: 'Camry', body: 'Sedan', fuel: 'petrol', tr: 'automatic', lo: 27000, hi: 39000, trims: ['SE', 'XSE', 'XLE'] },
  { co: 'Toyota', md: 'Tacoma', body: 'Pickup Truck', fuel: 'petrol', tr: 'automatic', lo: 34000, hi: 52000, trims: ['SR5', 'TRD Sport', 'TRD Off-Road'] },
  { co: 'Ford', md: 'F-150', body: 'Pickup Truck', fuel: 'petrol', tr: 'automatic', lo: 36000, hi: 62000, trims: ['XLT', 'Lariat', 'Sport'] },
  { co: 'Ford', md: 'Escape', body: 'SUV', fuel: 'petrol', tr: 'automatic', lo: 25000, hi: 37000, trims: ['SE', 'SEL', 'Titanium'] },
  { co: 'Ford', md: 'Mustang', body: 'Coupe', fuel: 'petrol', tr: 'manual', lo: 38000, hi: 58000, trims: ['EcoBoost', 'GT'] },
  { co: 'Chevrolet', md: 'Silverado 1500', body: 'Pickup Truck', fuel: 'petrol', tr: 'automatic', lo: 38000, hi: 60000, trims: ['LT', 'RST', 'LTZ'] },
  { co: 'Chevrolet', md: 'Equinox', body: 'SUV', fuel: 'petrol', tr: 'automatic', lo: 24000, hi: 35000, trims: ['LS', 'LT', 'Premier'] },
  { co: 'Hyundai', md: 'Elantra', body: 'Sedan', fuel: 'petrol', tr: 'cvt', lo: 18000, hi: 27000, trims: ['Preferred', 'Luxury', 'N Line'] },
  { co: 'Hyundai', md: 'Tucson', body: 'SUV', fuel: 'hybrid', tr: 'automatic', lo: 27000, hi: 39000, trims: ['Preferred', 'Trend', 'Ultimate'] },
  { co: 'Kia', md: 'Sportage', body: 'SUV', fuel: 'petrol', tr: 'automatic', lo: 27000, hi: 38000, trims: ['LX', 'EX', 'SX'] },
  { co: 'Kia', md: 'Forte', body: 'Sedan', fuel: 'petrol', tr: 'cvt', lo: 18000, hi: 25000, trims: ['LX', 'EX', 'GT'] },
  { co: 'Mazda', md: 'CX-5', body: 'SUV', fuel: 'petrol', tr: 'automatic', lo: 28000, hi: 40000, trims: ['GX', 'GS', 'GT'] },
  { co: 'Mazda', md: 'Mazda3', body: 'Hatchback', fuel: 'petrol', tr: 'automatic', lo: 21000, hi: 30000, trims: ['GX', 'GS', 'GT'] },
  { co: 'Nissan', md: 'Rogue', body: 'SUV', fuel: 'petrol', tr: 'cvt', lo: 26000, hi: 38000, trims: ['S', 'SV', 'SL', 'Platinum'] },
  { co: 'Nissan', md: 'Altima', body: 'Sedan', fuel: 'petrol', tr: 'cvt', lo: 24000, hi: 33000, trims: ['S', 'SV', 'SR'] },
  { co: 'Volkswagen', md: 'Jetta', body: 'Sedan', fuel: 'petrol', tr: 'automatic', lo: 22000, hi: 31000, trims: ['Trendline', 'Comfortline', 'Highline'] },
  { co: 'Tesla', md: 'Model 3', body: 'Sedan', fuel: 'electric', tr: 'automatic', lo: 40000, hi: 56000, trims: ['Standard Range', 'Long Range', 'Performance'] },
  { co: 'Tesla', md: 'Model Y', body: 'SUV', fuel: 'electric', tr: 'automatic', lo: 52000, hi: 68000, trims: ['Long Range', 'Performance'] },
  { co: 'BMW', md: '3 Series', body: 'Sedan', fuel: 'petrol', tr: 'automatic', lo: 40000, hi: 58000, trims: ['330i', 'M340i'] },
  { co: 'BMW', md: 'X5', body: 'SUV', fuel: 'petrol', tr: 'automatic', lo: 58000, hi: 82000, trims: ['xDrive40i', 'M50i'] },
  { co: 'Mercedes-Benz', md: 'C-Class', body: 'Sedan', fuel: 'petrol', tr: 'automatic', lo: 44000, hi: 62000, trims: ['C300', 'AMG C43'] },
  { co: 'Audi', md: 'Q5', body: 'SUV', fuel: 'petrol', tr: 'automatic', lo: 46000, hi: 66000, trims: ['Komfort', 'Progressiv', 'Technik'] },
  { co: 'Jeep', md: 'Wrangler', body: 'SUV', fuel: 'petrol', tr: 'automatic', lo: 38000, hi: 58000, trims: ['Sport', 'Sahara', 'Rubicon'] },
  { co: 'Jeep', md: 'Grand Cherokee', body: 'SUV', fuel: 'petrol', tr: 'automatic', lo: 44000, hi: 64000, trims: ['Laredo', 'Limited', 'Overland'] },
  { co: 'Subaru', md: 'Outback', body: 'SUV', fuel: 'petrol', tr: 'cvt', lo: 31000, hi: 43000, trims: ['Convenience', 'Touring', 'Premier'] },
  { co: 'GMC', md: 'Sierra 1500', body: 'Pickup Truck', fuel: 'petrol', tr: 'automatic', lo: 40000, hi: 64000, trims: ['Elevation', 'SLT', 'AT4'] },
  { co: 'Ram', md: '1500', body: 'Pickup Truck', fuel: 'petrol', tr: 'automatic', lo: 40000, hi: 64000, trims: ['Big Horn', 'Laramie', 'Sport'] },
  { co: 'Lexus', md: 'RX 350', body: 'SUV', fuel: 'hybrid', tr: 'automatic', lo: 50000, hi: 70000, trims: ['Premium', 'Luxury', 'F Sport'] },
  { co: 'Dodge', md: 'Charger', body: 'Sedan', fuel: 'petrol', tr: 'automatic', lo: 36000, hi: 55000, trims: ['SXT', 'R/T', 'Scat Pack'] },
];
const SPEND_CATS = ['reconditioning', 'repair', 'detailing', 'parts', 'service', 'transport', 'safety', 'tires'];
const FEATURES = ['Backup Camera', 'Bluetooth', 'Heated Seats', 'Sunroof', 'Apple CarPlay', 'Android Auto', 'Lane Assist', 'Adaptive Cruise', 'Blind Spot Monitor', 'Navigation', 'Leather Seats', 'Remote Start', 'Alloy Wheels', 'Keyless Entry', 'Power Liftgate'];

const emi = (P, annualRate, n) => {
  const r = annualRate / 12 / 100;
  if (r === 0) return P / n;
  const f = Math.pow(1 + r, n);
  return (P * r * f) / (f - 1);
};

// AppModule strings (en-dash via – to avoid encoding mishaps)
const M = {
  DASH: 'Dashboard', INV: 'Inventory', SELL: 'CRM – Sellers', BUY: 'CRM – Buyers',
  LEADS: 'Leads & Sales', ACC: 'Accounting', BHPH: 'BHPH', MKT: 'Digital Marketing',
  WEB: 'Dealer Website', MKTP: 'Dealer Marketplace', FB: 'Facebook Listings', CAL: 'Calendar',
  COMM: 'Communication', SUP: 'Support', STAFF: 'Staff', ROLES: 'Roles', SET: 'Settings',
};
const VA = (...a) => a.map((m) => ({ module: m, actions: ['view'] }));
const VEA = (...a) => a.map((m) => ({ module: m, actions: ['view', 'edit'] }));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const C = (n) => db.collection(n);
  const insert = async (name, docs) => { if (docs && docs.length) await C(name).insertMany(docs, { ordered: false }); };

  // ── Preserve anchors ───────────────────────────────────────────────
  const admin = await C('users').findOne({ email: 'hdrayka9060@gmail.com' });
  if (!admin) throw new Error('Admin user hdrayka9060@gmail.com not found — aborting to avoid lockout.');
  const sysRoles = await C('roles').find({ isSystem: true }).toArray();
  const roleByName = {};
  for (const r of sysRoles) roleByName[r.name] = r._id;
  if (!roleByName['Admin']) throw new Error('System role "Admin" not found — aborting.');
  const fbConn = await C('facebook_connections').findOne({ isDeleted: { $ne: true } });
  const googleConn = await C('ads_connections').findOne({ provider: 'google', isDeleted: { $ne: true } });
  const metaConn = await C('ads_connections').findOne({ provider: 'meta', isDeleted: { $ne: true } });

  console.log('Preserving admin:', admin.email, '| system roles:', Object.keys(roleByName).join(', '));
  console.log('FB connection:', fbConn ? fbConn.pageName : '(none)', '| Google ads:', !!googleConn, '| Meta ads:', !!metaConn);

  // ── Clean ──────────────────────────────────────────────────────────
  const wipe = [
    'vehicles', 'buyer_leads', 'seller_leads', 'leads', 'sales', 'expenses', 'calendar_events',
    'communication_logs', 'loans', 'tickets', 'campaigns', 'activities', 'conversations', 'messages',
    'facebook_listings', 'facebook_comments', 'facebook_engagement', 'facebook_conversations',
    'facebook_messages', 'facebook_group_targets', 'facebook_listing_templates', 'ads_insight_snapshots',
  ];
  for (const c of wipe) { const r = await C(c).deleteMany({}); console.log(`  wiped ${c}: ${r.deletedCount}`); }
  const delUsers = await C('users').deleteMany({ _id: { $ne: admin._id } });
  const delRoles = await C('roles').deleteMany({ isSystem: { $ne: true } });
  console.log(`  wiped users (kept admin): ${delUsers.deletedCount} | non-system roles: ${delRoles.deletedCount}`);

  const docs = { roles: [], users: [], sellers: [], vehicles: [], buyers: [], leads: [], sales: [], expenses: [], calendar: [], comms: [], loans: [], activities: [], adsSnaps: [], fbListings: [], fbEng: [], fbComments: [] };

  // ── Custom roles ───────────────────────────────────────────────────
  const finRoleId = oid(), recRoleId = oid();
  docs.roles.push({
    _id: finRoleId, name: 'Finance Manager', description: 'Owns financing, BHPH loans and the books',
    permissions: [
      { module: M.DASH, actions: ['view'] },
      { module: M.ACC, actions: ['view', 'edit', 'delete'] },
      { module: M.BHPH, actions: ['view', 'edit', 'delete'] },
      ...VA(M.INV, M.LEADS, M.BUY, M.CAL),
    ],
    isSystem: false, isDeleted: false, createdAt: daysAgo(WINDOW), updatedAt: daysAgo(WINDOW),
  });
  docs.roles.push({
    _id: recRoleId, name: 'Receptionist', description: 'Front desk — scheduling and customer intake',
    permissions: [
      { module: M.DASH, actions: ['view'] },
      ...VEA(M.CAL, M.COMM),
      ...VA(M.BUY, M.LEADS),
    ],
    isSystem: false, isDeleted: false, createdAt: daysAgo(WINDOW - 20), updatedAt: daysAgo(WINDOW - 20),
  });

  // ── Staff ──────────────────────────────────────────────────────────
  const pwHash = await bcrypt.hash('Welcome@123', 12);
  const staffDefs = [
    { first: 'Marcus', last: 'Bennett', role: 'Sales Manager', rid: roleByName['Sales Manager'], dept: 'Sales', hired: WINDOW },
    { first: 'Priya', last: 'Sharma', role: 'Sales Staff', rid: roleByName['Sales Staff'], dept: 'Sales', hired: WINDOW - 8 },
    { first: 'David', last: 'Nguyen', role: 'Sales Staff', rid: roleByName['Sales Staff'], dept: 'Sales', hired: WINDOW - 30 },
    { first: 'Sofia', last: 'Rossi', role: 'Sales Staff', rid: roleByName['Sales Staff'], dept: 'Sales', hired: 120 },
    { first: 'Jamal', last: 'Carter', role: 'Sales Staff', rid: roleByName['Sales Staff'], dept: 'Sales', hired: 70 },
    { first: 'Emily', last: 'Chen', role: 'Marketing', rid: roleByName['Marketing'], dept: 'Marketing', hired: WINDOW - 15 },
    { first: 'Liam', last: 'Murphy', role: 'Marketing', rid: roleByName['Marketing'], dept: 'Marketing', hired: 55 },
    { first: 'Aisha', last: 'Khan', role: 'Support', rid: roleByName['Support'], dept: 'Customer Care', hired: 95 },
    { first: 'Ryan', last: 'Thompson', role: 'Finance Manager', rid: finRoleId, dept: 'Finance', hired: WINDOW - 5 },
    { first: 'Grace', last: 'Park', role: 'Receptionist', rid: recRoleId, dept: 'Front Desk', hired: 40 },
  ];
  const staff = []; // {_id, name, first, role, isSales}
  staffDefs.forEach((s, i) => {
    const _id = oid();
    const created = clampPast(daysAgo(s.hired));
    docs.users.push({
      _id, firstName: s.first, lastName: s.last,
      email: `${s.first}.${s.last}`.toLowerCase() + '@mapleleafmotors.ca',
      password: pwHash, roleId: s.rid, status: 'active', phone: phone(), avatar: '', department: s.dept,
      isDeleted: false, createdAt: created, updatedAt: created,
    });
    staff.push({ _id, name: `${s.first} ${s.last}`, first: s.first, role: s.role, isSales: s.role === 'Sales Manager' || s.role === 'Sales Staff' });
  });
  const adminActor = { _id: admin._id, name: `${admin.firstName} ${admin.lastName}`, isSales: true };
  const allActors = [adminActor, ...staff];
  const salesPeople = staff.filter((s) => s.isSales).concat([adminActor]);
  const salesPerson = () => pick(salesPeople);

  // activity helper
  const logAct = (module, action, entity, entityId, label, actor, meta, when) =>
    docs.activities.push({
      _id: oid(), module, action, entity, entityId: String(entityId), label,
      by: actor ? actor.name : 'System', byId: actor ? actor._id : undefined, meta: meta || {},
      isDeleted: false, createdAt: when, updatedAt: when,
    });

  staff.forEach((s) => {
    const u = docs.users.find((x) => x._id === s._id);
    logAct('users', 'invited', 'User', s._id, `${s.name} (${s.role})`, adminActor, { roleName: s.role }, u.createdAt);
    logAct('users', 'invite-accepted', 'User', s._id, s.name, s, {}, addDays(u.createdAt, 1));
  });

  // ── Sellers ────────────────────────────────────────────────────────
  const sellers = []; // {_id, name, email, phone, vehicles:[]}
  for (let i = 0; i < 14; i++) {
    const _id = oid();
    const p = { first: pick(FIRST), last: pick(LAST) };
    const created = dateBetween(WINDOW, 5);
    const stage = weighted([['sold', 5], ['inspection', 3], ['negotiation', 2], ['contacted', 3], ['new', 2], ['rejected', 1]]);
    const assignee = salesPerson();
    sellers.push({ _id, name: fullName(p), email: emailFor(p.first, p.last, i), phone: phone(), created, stage, assignee, vehicles: [] });
  }

  // ── Vehicles ───────────────────────────────────────────────────────
  const statusPlan = shuffle([
    ...Array(28).fill('sold'), ...Array(12).fill('unsold'), ...Array(7).fill('pending'),
    ...Array(3).fill('reserved'), ...Array(4).fill('test_drive'), ...Array(3).fill('inspection'), ...Array(3).fill('new'),
  ]);
  const vehicles = []; // rich working objects
  const thisYear = NOW.getFullYear();
  statusPlan.forEach((status, i) => {
    const _id = oid();
    const t = pick(CATALOG);
    const year = int(2017, thisYear);
    const age = Math.max(0, thisYear - year);
    const trim = pick(t.trims);
    let price = round(flo(t.lo, t.hi) * (1 - Math.min(0.32, age * 0.05)), 100);
    price = Math.max(price, 9900);
    const km = status === 'new' ? int(5, 1500) : round(age * int(11000, 21000) + int(500, 9000), 100);
    const costPrice = round(price * flo(0.80, 0.88), 50);
    const discount = chance(0.4) ? round(price * flo(0.01, 0.035), 50) : 0;

    // dates
    let soldDate = null, created;
    if (status === 'sold') {
      soldDate = dateBetween(WINDOW - 5, 3);
      created = clampPast(addDays(soldDate, -int(12, 110)));
      if (created.getTime() < daysAgo(WINDOW).getTime()) created = daysAgo(WINDOW);
    } else if (status === 'new') {
      created = daysAgo(int(0, 1));
    } else {
      created = dateBetween(WINDOW, 2);
    }

    // spends (reconditioning) — added between acquisition and sale
    const spends = [];
    if (chance(0.6)) {
      const n = int(1, 3);
      for (let k = 0; k < n; k++) {
        const sd = soldDate ? dateBetween2(created, soldDate) : dateBetween2(created, NOW);
        spends.push({ amount: round(int(150, 2400), 5), category: pick(SPEND_CATS), description: pick(['Brake pads + rotors', 'Full detail', 'New all-season tires', 'Oil + filter service', 'Windshield replacement', 'Safety certification', 'Battery replacement', 'Alignment']), date: sd, by: salesPerson().name });
      }
    }
    const totalSpend = spends.reduce((s, x) => s + x.amount, 0);

    // exposure
    const exposureDays = Math.max(1, Math.round((NOW - created) / DAY));
    const views = Math.min(1200, round(exposureDays * flo(1.5, 6) + int(5, 40)));
    const clicks = round(views * flo(0.25, 0.6));
    const inquiries = round(views * flo(0.02, 0.07));

    // seller link (~35%)
    let sellerRef = null;
    if (chance(0.35)) {
      const sel = pick(sellers);
      sel.vehicles.push(_id);
      sellerRef = sel._id;
    }

    const title = `${year} ${t.co} ${t.md}${trim ? ' ' + trim : ''}`;
    const addedBy = pick(allActors);
    const v = {
      _id, t, status, year, trim, price, costPrice, discount, km, soldDate, created, spends, totalSpend, title, addedBy, sellerRef,
      doc: {
        _id, vehicleNumber: `V-${String(i + 1).padStart(5, '0')}`, title,
        description: `${year} ${t.co} ${t.md} ${trim} — ${t.body}. ${km.toLocaleString('en-US')} km. ${pick(['Clean CarFax, no accidents.', 'One owner, well maintained.', 'Certified pre-owned, fully inspected.', 'Trade-in special, priced to sell.', 'Low kilometres for the year.'])}`,
        photos: vehiclePhotos(i), company: t.co, model: t.md, year, km, price, discount, costPrice,
        soldAt: status === 'sold' ? price - discount : 0, soldDate: status === 'sold' ? soldDate : null,
        owners: int(1, 3), fuelType: t.fuel, transmission: t.tr, color: pick(COLORS), vin: vin(), bodyType: t.body, trim,
        engine: t.fuel === 'electric' ? 'Dual Motor AWD' : `${flo(1.5, 3.5).toFixed(1)}L · ${pick([4, 4, 4, 6, 6, 8])}-cyl`,
        status, hosting: chance(0.7) ? 'platform' : 'self', features: pickN(FEATURES, int(4, 8)), history: [],
        spends, totalSpend,
        traffic: { views, clicks, inquiries, lastViewed: dateBetween(20, 0) },
        addedBy: addedBy._id, seller: sellerRef, isDeleted: false, createdAt: created, updatedAt: status === 'sold' ? soldDate : created,
      },
    };
    vehicles.push(v);
    logAct('inventory', 'created', 'Vehicle', _id, `${title} (${v.doc.vehicleNumber})`, addedBy, { price, status: 'new' }, created);
  });
  function dateBetween2(a, b) { const lo = a.getTime(), hi = b.getTime(); return new Date(lo + rnd() * Math.max(0, hi - lo)); }

  // push vehicle docs
  vehicles.forEach((v) => docs.vehicles.push(v.doc));

  // ── Buyers ─────────────────────────────────────────────────────────
  const buyers = [];
  for (let i = 0; i < 46; i++) {
    const _id = oid();
    const p = { first: pick(FIRST), last: pick(LAST) };
    const created = dateBetween(WINDOW, 1);
    buyers.push({
      _id, name: fullName(p), email: emailFor(p.first, p.last, i), buyerPhone: phone(), created,
      assignee: salesPerson(), budget: round(int(18, 70) * 1000, 500),
      interested: [], communications: [], history: [], purchases: [], stage: 'new', hasLead: false,
    });
  }
  let buyerCursor = 0;
  const nextBuyer = () => { const b = buyers[buyerCursor % buyers.length]; buyerCursor++; return b; };

  const usedPairs = new Set();
  const SOURCES = [['website', 4], ['meta_ads', 3], ['google_ads', 3], ['referral', 2], ['walk_in', 2]];
  const LEAD_CHANNELS = ['call', 'email', 'whatsapp', 'sms', 'offline'];

  const makeLead = (buyer, v, status, opts = {}) => {
    const key = `${buyer._id}:${v._id}`;
    if (usedPairs.has(key)) return null;
    usedPairs.add(key);
    const _id = oid();
    const assignee = opts.assignee || buyer.assignee;
    const start = opts.start || dateBetween2(v.created, opts.end || NOW);
    const timeline = [{ date: start, action: 'Lead created', by: assignee.name }];
    const log = [];
    const stages = ['new', 'contacted', 'test_drive', 'negotiation', 'closed'];
    const reach = { new: 0, contacted: 1, test_drive: 2, negotiation: 3, closed: 4, archived: 1 }[status] ?? 0;
    let cur = start;
    for (let s = 1; s <= reach; s++) {
      cur = dateBetween2(cur, opts.end || NOW);
      const stg = stages[s];
      if (stg === 'contacted') {
        const ch = pick(LEAD_CHANNELS);
        log.push({ _id: oid(), date: cur, channel: ch, summary: pick(['Answered inquiry about availability.', 'Discussed pricing and financing options.', 'Followed up after website inquiry.', 'Confirmed vehicle still available.']), vehicle: v._id, vehicleTitle: v.title, byStaff: assignee._id });
        timeline.push({ date: cur, action: 'Status → Contacted', by: assignee.name });
      } else if (stg === 'test_drive') {
        timeline.push({ date: cur, action: 'Test drive booked', by: assignee.name });
      } else if (stg === 'negotiation') {
        timeline.push({ date: cur, action: 'Status → Negotiation', by: assignee.name });
      } else if (stg === 'closed') {
        timeline.push({ date: cur, action: 'Lead closed — vehicle sold', by: assignee.name });
      }
    }
    if (status === 'archived') {
      cur = dateBetween2(cur, opts.end || NOW);
      timeline.push({ date: cur, action: 'Auto-archived — vehicle sold to another buyer', by: 'System' });
    }
    const askedPrice = (status === 'negotiation' || status === 'closed') ? round(v.price - v.discount - int(0, 1500), 50) : 0;
    docs.leads.push({
      _id, buyer: buyer._id, vehicle: v._id, source: weighted(SOURCES), status, assignedTo: assignee._id,
      notes: opts.notes || '', askedPrice, timeline, log, isDeleted: false, createdAt: start, updatedAt: cur,
    });
    if (!buyer.interested.find((x) => String(x) === String(v._id))) buyer.interested.push(v._id);
    buyer.hasLead = true;
    logAct('leads', 'created', 'Lead', _id, `${buyer.name} — ${v.title}`, assignee, { source: 'lead', status }, start);
    if (status === 'closed') logAct('leads', 'closed', 'Lead', _id, `${buyer.name} — ${v.title}`, assignee, {}, cur);
    if (status === 'archived') logAct('leads', 'archived', 'Lead', _id, `${buyer.name} — ${v.title}`, adminActor, {}, cur);
    return { _id, end: cur };
  };

  // ── Sales (sold vehicles) + their leads + buyer purchases + loans ──
  const PAY_METHODS = [['cash', 4], ['finance', 5], ['bhph', 2], ['trade_in', 2]];
  let loanCount = 0;
  vehicles.filter((v) => v.status === 'sold').forEach((v) => {
    const buyer = nextBuyer();
    const saleDate = v.soldDate;
    const lead = makeLead(buyer, v, 'closed', { start: clampPast(addDays(saleDate, -int(5, 40))), end: saleDate });
    const net = v.price - v.discount;
    const method = weighted(PAY_METHODS);
    const status = weighted([['paid', 7], ['partial', 2], ['pending', 1]]);
    const amountPaid = status === 'paid' ? net : status === 'partial' ? round(net * flo(0.3, 0.7), 100) : 0;
    const saleId = oid();
    docs.sales.push({
      _id: saleId, vehicleTitle: v.title, vehicleId: String(v._id), buyerName: buyer.name, buyerEmail: buyer.email,
      salePrice: v.price, costPrice: v.costPrice, totalSpend: v.totalSpend, discount: v.discount, amountPaid,
      saleDate, paymentMethod: method, paymentStatus: status, notes: '', isDeleted: false, createdAt: saleDate, updatedAt: saleDate,
    });
    buyer.stage = 'purchased';
    buyer.purchases.push({ _id: oid(), at: saleDate, vehicle: v._id, vehicleTitle: v.title, soldAt: net, soldDate: saleDate, paymentMethod: method, paymentStatus: status, leadId: lead ? lead._id : undefined, saleId });
    if (!buyer.interested.find((x) => String(x) === String(v._id))) buyer.interested.push(v._id);
    logAct('accounting', 'sale-recorded', 'Sale', saleId, `${v.title} sold to ${buyer.name} · $${net.toLocaleString('en-US')}`, v.addedBy.isSales ? v.addedBy : salesPerson(), { net, method }, saleDate);

    // sibling archived leads (other buyers on same vehicle)
    if (chance(0.4)) {
      const sibs = int(1, 2);
      for (let s = 0; s < sibs; s++) {
        const ob = nextBuyer();
        if (ob._id === buyer._id) continue;
        makeLead(ob, v, 'archived', { start: clampPast(addDays(saleDate, -int(8, 50))), end: saleDate });
      }
    }

    // BHPH / finance loan
    if ((method === 'bhph' || method === 'finance') && loanCount < 6 && status !== 'pending') {
      loanCount++;
      const down = round(net * flo(0.1, 0.25), 100);
      const principal = net - down;
      const rate = method === 'bhph' ? flo(9, 15) : flo(5.5, 8.5);
      const term = pick([36, 48, 60, 72]);
      const emiAmt = round(emi(principal, rate, term), 1);
      const monthsElapsed = Math.min(term, Math.max(0, Math.floor((NOW - saleDate) / (30.4 * DAY))));
      const payments = [];
      let totalPaid = 0;
      for (let mo = 1; mo <= monthsElapsed; mo++) {
        const pd = addDays(saleDate, mo * 30);
        if (pd > NOW) break;
        if (chance(0.92)) { payments.push({ amount: emiAmt, date: pd, method: pick(['cash', 'e-transfer', 'debit', 'cheque']), notes: '', receiptNumber: `RCT-${int(10000, 99999)}` }); totalPaid += emiAmt; }
      }
      const paidOff = totalPaid >= principal - 1;
      docs.loans.push({
        _id: oid(), borrowerName: buyer.name, borrowerEmail: buyer.email, borrowerPhone: buyer.buyerPhone,
        vehicle: v._id, vehicleTitle: v.title, principal, interestRatePercent: round(rate, 1), termMonths: term,
        emiAmount: emiAmt, startDate: saleDate, endDate: addDays(saleDate, term * 30), totalPaid: round(totalPaid, 1),
        status: paidOff ? 'paid_off' : 'active', payments, notes: `${method === 'bhph' ? 'In-house BHPH' : 'Bank finance'} · $${down.toLocaleString('en-US')} down`,
        isDeleted: false, createdAt: saleDate, updatedAt: payments.length ? payments[payments.length - 1].date : saleDate,
      });
    }
  });

  // ── Active leads on non-sold vehicles ──────────────────────────────
  const activeStatusFor = (vs) => {
    if (vs === 'reserved') return weighted([['negotiation', 6], ['test_drive', 3], ['contacted', 1]]);
    if (vs === 'pending') return weighted([['negotiation', 4], ['test_drive', 3], ['contacted', 3]]);
    if (vs === 'test_drive') return weighted([['test_drive', 6], ['contacted', 3], ['negotiation', 1]]);
    if (vs === 'inspection') return weighted([['contacted', 5], ['new', 4], ['test_drive', 1]]);
    return weighted([['new', 4], ['contacted', 4], ['test_drive', 1], ['negotiation', 1]]);
  };
  vehicles.filter((v) => v.status !== 'sold' && v.status !== 'new').forEach((v) => {
    const n = weighted([[0, 2], [1, 5], [2, 3]]);
    for (let k = 0; k < n; k++) makeLead(nextBuyer(), v, activeStatusFor(v.status));
  });

  // Ensure no buyer is empty: give browsing interest + comms to all buyers
  buyers.forEach((b, i) => {
    if (b.interested.length === 0) {
      const picks = pickN(vehicles, int(1, 3));
      picks.forEach((v) => b.interested.push(v._id));
    }
    if (!b.hasLead && b.stage === 'new') {
      b.stage = weighted([['new', 3], ['contacted', 4], ['test_drive', 2], ['negotiation', 1], ['lost', 2]]);
    }
    // communications log on the buyer record
    const nc = b.stage === 'purchased' ? int(2, 5) : int(0, 3);
    for (let k = 0; k < nc; k++) {
      const tgt = pick(b.interested);
      const v = vehicles.find((x) => String(x._id) === String(tgt));
      const sp = b.assignee;
      const when = dateBetween2(b.created, NOW);
      b.communications.push({ _id: oid(), at: when, channel: pick(['call', 'email', 'whatsapp', 'sms', 'offline']), vehicle: v ? v._id : undefined, vehicleTitle: v ? v.title : undefined, summary: pick(['Sent vehicle details and photos.', 'Discussed trade-in valuation.', 'Booked a showroom visit.', 'Answered financing questions.', 'Followed up on quote.']), by: sp.name, byStaff: sp._id });
    }
    if (chance(0.3)) {
      const tgt = pick(b.interested);
      const v = vehicles.find((x) => String(x._id) === String(tgt));
      if (v) b.history.push({ vehicleId: String(v._id), vehicleTitle: v.title, action: 'test_drive_booked', date: dateBetween2(b.created, NOW) });
    }
    logAct('crm-buyers', 'created', 'Buyer', b._id, b.name, b.assignee, { stage: b.stage }, b.created);
  });

  // push buyer docs
  buyers.forEach((b) => {
    docs.buyers.push({
      _id: b._id, buyerName: b.name, buyerEmail: b.email, buyerPhone: b.buyerPhone, notes: '',
      interestedVehicles: b.interested, budget: b.budget, stage: b.stage, assignedTo: b.assignee._id,
      history: b.history, communications: b.communications, purchases: b.purchases,
      isDeleted: false, createdAt: b.created, updatedAt: b.created,
    });
  });

  // push seller docs (+ activity)
  sellers.forEach((s) => {
    const activity = [{ at: s.created, action: 'created', label: 'Seller lead created', by: s.assignee.name }];
    if (s.vehicles.length) activity.push({ at: addDays(s.created, int(1, 6)), action: 'vehicle-added', label: `${s.vehicles.length} vehicle(s) added to inventory`, by: s.assignee.name });
    if (s.stage === 'inspection' || s.stage === 'sold') activity.push({ at: addDays(s.created, int(2, 10)), action: 'inspection', label: 'Inspection scheduled', by: s.assignee.name });
    const firstV = s.vehicles.length ? vehicles.find((v) => String(v._id) === String(s.vehicles[0])) : null;
    docs.sellers.push({
      _id: s._id, sellerName: s.name, sellerEmail: s.email, sellerPhone: s.phone,
      notes: pick(['Repeat seller — easy to work with.', 'Wants top dollar, motivated.', 'Downsizing, multiple vehicles.', '']),
      address: `${int(20, 9000)} ${pick(STREETS)}`, city: pick(CITIES), state: 'ON', zipCode: postal(), country: 'Canada',
      vehicles: s.vehicles,
      vehicleTitle: firstV ? firstV.title : '', vehicleCompany: firstV ? firstV.t.co : '', vehicleModel: firstV ? firstV.t.md : '',
      vehicleYear: firstV ? firstV.year : 0, vehicleKm: firstV ? firstV.doc.km : 0, askingPrice: firstV ? firstV.price + int(500, 3000) : 0, vehiclePhotos: [],
      stage: s.stage, inspectionDate: (s.stage === 'inspection' || s.stage === 'sold') ? addDays(s.created, int(2, 10)) : undefined,
      assignedTo: s.assignee._id, communications: [], activity,
      isDeleted: false, createdAt: s.created, updatedAt: s.created,
    });
    logAct('crm-sellers', 'created', 'Seller', s._id, s.name, s.assignee, { stage: s.stage }, s.created);
  });

  // ── Expenses (operating, ~6 months) ────────────────────────────────
  const months = [];
  for (let m = 0; m < 7; m++) months.push(new Date(NOW.getFullYear(), NOW.getMonth() - m, 1));
  const EXP = [
    { title: 'Showroom lease', amount: () => 6500, category: 'utilities', vendor: 'Hurontario Properties', monthly: true },
    { title: 'Staff payroll', amount: () => round(int(28, 42) * 1000, 100), category: 'staff', vendor: 'Payroll', monthly: true },
    { title: 'Google Ads spend', amount: () => round(int(1800, 3600), 10), category: 'marketing', vendor: 'Google', monthly: true },
    { title: 'Meta Ads spend', amount: () => round(int(1200, 2800), 10), category: 'marketing', vendor: 'Meta', monthly: true },
    { title: 'Hydro & utilities', amount: () => round(int(600, 1200), 10), category: 'utilities', vendor: 'Alectra', monthly: true },
    { title: 'Insurance premium', amount: () => 2100, category: 'general', vendor: 'Intact Insurance', monthly: true },
    { title: 'Lot maintenance & snow removal', amount: () => round(int(300, 900), 10), category: 'maintenance', vendor: 'GTA Property Care', monthly: false },
    { title: 'Office supplies', amount: () => round(int(120, 480), 5), category: 'general', vendor: 'Staples', monthly: false },
    { title: 'AutoTrader listing fees', amount: () => round(int(700, 1400), 10), category: 'marketing', vendor: 'AutoTrader.ca', monthly: true },
    { title: 'Software subscriptions', amount: () => round(int(250, 600), 5), category: 'other', vendor: 'Various SaaS', monthly: true },
  ];
  months.forEach((mStart) => {
    EXP.forEach((e) => {
      if (!e.monthly && !chance(0.5)) return;
      const day = int(1, 26);
      const date = new Date(mStart.getFullYear(), mStart.getMonth(), day);
      if (date > NOW) return;
      const _id = oid();
      docs.expenses.push({ _id, title: e.title, amount: e.amount(), date, category: e.category, vendor: e.vendor, notes: '', isDeleted: false, createdAt: date, updatedAt: date });
      logAct('accounting', 'created', 'Expense', _id, `${e.title} · $${docs.expenses[docs.expenses.length - 1].amount.toLocaleString('en-US')}`, pick(allActors), { category: e.category }, date);
    });
  });

  // ── Calendar events ────────────────────────────────────────────────
  const meetingTitles = ['Team sales huddle', 'Inventory review', 'Monthly numbers review', 'Vendor meeting', 'Marketing sync'];
  const mkParticipant = (actorOrBuyer, type) => ({ _id: oid(), userType: type, userId: actorOrBuyer._id, name: actorOrBuyer.name, email: actorOrBuyer.email || '', status: pick(['accepted', 'invited', 'accepted']), invitedAt: NOW });
  // past completed test drives / inspections tied to leads/vehicles
  const soldVehicles = vehicles.filter((v) => v.status === 'sold');
  const activeVehicles = vehicles.filter((v) => v.status !== 'sold');
  for (let i = 0; i < 30; i++) {
    const past = i < 22;
    const v = pick(vehicles);
    const buyer = pick(buyers);
    const sp = salesPerson();
    const type = weighted([['test_drive', 5], ['inspection', 2], ['meeting', 2], ['other', 1]]);
    const day = past ? dateBetween(WINDOW, 2) : daysAgo(-int(1, 18));
    const start = at(day, int(9, 17), pick([0, 30]));
    const end = new Date(start.getTime() + 60 * 60000);
    const status = past ? weighted([['completed', 7], ['no_show', 1], ['cancelled', 1]]) : 'scheduled';
    const isMeeting = type === 'meeting';
    const _id = oid();
    docs.calendar.push({
      _id, title: isMeeting ? pick(meetingTitles) : `${type === 'test_drive' ? 'Test Drive' : type === 'inspection' ? 'Inspection' : 'Appointment'} — ${v.title}`,
      description: '', startDateTime: start, endDateTime: end, eventType: type, status,
      assignedTo: sp._id, createdBy: sp._id,
      customerName: isMeeting ? '' : buyer.name, customerPhone: isMeeting ? '' : buyer.buyerPhone, customerEmail: isMeeting ? '' : buyer.email,
      vehicle: isMeeting ? undefined : v._id, lead: undefined,
      meetingType: 'physical', meetLink: '', googleEventId: '', location: `Maple Leaf Motors — 2280 Battleford Rd, Mississauga`,
      participants: isMeeting ? pickN(staff, int(2, 4)).map((s) => mkParticipant(s, 'staff')) : [mkParticipant(sp, 'staff'), mkParticipant(buyer, 'buyer')],
      notes: '', isDeleted: false, createdAt: clampPast(addDays(start, -int(1, 5))), updatedAt: clampPast(start),
    });
    logAct('calendar', 'created', 'Calendar Event', _id, docs.calendar[docs.calendar.length - 1].title, sp, { eventType: type }, docs.calendar[docs.calendar.length - 1].createdAt);
  }
  // guaranteed upcoming scheduled test drives (drive the Pending Test Drives KPI)
  for (let i = 0; i < 8; i++) {
    const v = pick(activeVehicles);
    const buyer = pick(buyers);
    const sp = salesPerson();
    const start = at(daysAgo(-int(1, 14)), int(10, 17), pick([0, 30]));
    const end = new Date(start.getTime() + 60 * 60000);
    const _id = oid();
    docs.calendar.push({
      _id, title: `Test Drive — ${v.title}`, description: '', startDateTime: start, endDateTime: end,
      eventType: 'test_drive', status: 'scheduled', assignedTo: sp._id, createdBy: sp._id,
      customerName: buyer.name, customerPhone: buyer.buyerPhone, customerEmail: buyer.email, vehicle: v._id,
      meetingType: 'physical', meetLink: '', googleEventId: '', location: 'Maple Leaf Motors — 2280 Battleford Rd, Mississauga',
      participants: [mkParticipant(sp, 'staff'), mkParticipant(buyer, 'buyer')], notes: '',
      isDeleted: false, createdAt: daysAgo(int(0, 3)), updatedAt: daysAgo(int(0, 3)),
    });
    logAct('calendar', 'created', 'Calendar Event', _id, `Test Drive — ${v.title}`, sp, { eventType: 'test_drive' }, docs.calendar[docs.calendar.length - 1].createdAt);
  }

  // ── Communication logs ─────────────────────────────────────────────
  const SUBJECTS = { email: ['Your vehicle quote', 'Financing pre-approval', 'Trade-in appraisal', 'Booking confirmation', 'Following up'], sms: ['Appointment reminder', 'Vehicle available', 'Quick follow-up'], whatsapp: ['Photos as requested', 'Test drive confirmed', 'Price update'], call: ['Outbound sales call', 'Returned customer call', 'Financing discussion'] };
  for (let i = 0; i < 34; i++) {
    const b = pick(buyers);
    const ch = pick(['email', 'sms', 'whatsapp', 'call']);
    const tgt = b.interested.length ? pick(b.interested) : null;
    const v = tgt ? vehicles.find((x) => String(x._id) === String(tgt)) : null;
    const sp = salesPerson();
    const when = dateBetween2(b.created, NOW);
    docs.comms.push({
      _id: oid(), channel: ch, direction: pick(['outbound', 'outbound', 'inbound']), recipientName: b.name, recipientContact: ch === 'call' || ch === 'sms' || ch === 'whatsapp' ? b.buyerPhone : b.email,
      subject: pick(SUBJECTS[ch]), message: pick(['Thanks for your interest — let me know if you have questions.', 'Attaching the details we discussed.', 'Happy to set up a test drive this week.', 'Following up on your inquiry.']),
      linkedVehicle: v ? v._id : undefined, linkedLeadId: '', contactType: b.hasLead ? 'lead' : 'customer', sentBy: sp._id,
      deliveryStatus: pick(['sent', 'delivered', 'delivered', 'delivered']), callDurationSeconds: ch === 'call' ? int(45, 900) : undefined,
      createdAt: when, updatedAt: when,
    });
  }

  // recent freshness: a few activities in the last 48h
  logAct('inventory', 'updated', 'Vehicle', vehicles[0]._id, `${vehicles[0].title} price adjusted`, salesPerson(), {}, daysAgo(0));
  logAct('leads', 'updated', 'Lead', docs.leads[0]._id, `${buyers[0].name} — follow-up logged`, salesPerson(), {}, daysAgo(1));

  // ── Ads insight snapshots (Marketing tab) ──────────────────────────
  const seedAds = (conn, campaigns) => {
    if (!conn) return;
    const acct = conn.accountId || '';
    for (let d = WINDOW - 12; d >= 0; d--) {
      const date = ymd(daysAgo(d));
      const dow = daysAgo(d).getDay();
      const weekend = dow === 0 || dow === 6 ? 0.7 : 1;
      campaigns.forEach((c) => {
        const imp = Math.round(c.baseImp * flo(0.7, 1.3) * weekend);
        const clicks = Math.round(imp * flo(c.ctr * 0.8, c.ctr * 1.2));
        const spend = round(clicks * flo(c.cpc * 0.85, c.cpc * 1.15), 0.01);
        const conv = Math.round(clicks * flo(c.cvr * 0.7, c.cvr * 1.3));
        const convVal = round(conv * flo(c.aov * 0.85, c.aov * 1.15), 0.01);
        docs.adsSnaps.push({ _id: oid(), connection: conn._id, provider: conn.provider, accountId: acct, date, campaignId: c.id, campaignName: c.name, spend, impressions: imp, clicks, conversions: conv, conversionValue: convVal, fetchedAt: NOW, isDeleted: false, createdAt: daysAgo(d), updatedAt: daysAgo(d) });
      });
    }
  };
  seedAds(googleConn, [
    { id: 'g-search-used', name: 'Search — Used Cars GTA', baseImp: 1400, ctr: 0.06, cpc: 1.9, cvr: 0.05, aov: 480 },
    { id: 'g-search-brand', name: 'Search — Brand', baseImp: 600, ctr: 0.11, cpc: 0.9, cvr: 0.08, aov: 520 },
    { id: 'g-pmax-inventory', name: 'Performance Max — Inventory', baseImp: 5200, ctr: 0.018, cpc: 0.7, cvr: 0.03, aov: 450 },
    { id: 'g-display-remarket', name: 'Display — Remarketing', baseImp: 9000, ctr: 0.008, cpc: 0.35, cvr: 0.015, aov: 400 },
  ]);
  seedAds(metaConn, [
    { id: 'm-mktplace', name: 'Marketplace Vehicle Ads', baseImp: 7000, ctr: 0.022, cpc: 0.55, cvr: 0.035, aov: 430 },
    { id: 'm-leadgen', name: 'Lead Gen — Trade-In', baseImp: 3200, ctr: 0.03, cpc: 0.8, cvr: 0.06, aov: 500 },
    { id: 'm-awareness', name: 'Awareness — Brand', baseImp: 12000, ctr: 0.006, cpc: 0.25, cvr: 0.008, aov: 350 },
    { id: 'm-retarget', name: 'Retargeting — Website', baseImp: 4200, ctr: 0.019, cpc: 0.5, cvr: 0.04, aov: 460 },
  ]);

  // ── Facebook listings + engagement + comments ──────────────────────
  if (fbConn) {
    const fbVehicles = pickN(vehicles.filter((v) => v.status !== 'new'), 12);
    fbVehicles.forEach((v, idx) => {
      const _id = oid();
      const isSold = v.status === 'sold';
      const status = isSold ? (chance(0.5) ? 'sold' : 'active') : weighted([['active', 7], ['draft', 1], ['failed', 1]]);
      const publishedAt = status === 'draft' ? undefined : dateBetween2(v.created, NOW);
      const reactions = int(3, 90), comments = int(0, 14), shares = int(0, 12), views = int(40, 1400);
      docs.fbListings.push({
        _id, vehicle: v._id, vehicleTitle: v.title, destinationType: chance(0.2) ? 'marketplace_catalog' : 'page',
        connection: fbConn._id, destinationName: fbConn.pageName, destinationUrl: '',
        title: v.title, description: `${v.title} — ${v.doc.km.toLocaleString('en-US')} km · $${(v.price - v.discount).toLocaleString('en-US')}. Message us to book a test drive!`,
        price: v.price - v.discount, photos: v.doc.photos.slice(0, 4), location: 'Mississauga, ON', contact: '(905) 555-0142',
        status, fbPostId: status === 'draft' ? '' : `${fbConn.pageId}_${int(100000000, 999999999)}`,
        fbPermalink: status === 'draft' ? '' : `https://facebook.com/${fbConn.pageId}/posts/${int(100000000, 999999999)}`,
        publishedAt, lastError: status === 'failed' ? 'Facebook: (#200) pages_manage_posts permission required' : '',
        engagement: status === 'draft' ? {} : { reactions, comments, shares, views, fetchedAt: NOW },
        createdBy: pick(allActors)._id, isDeleted: false, createdAt: publishedAt || dateBetween2(v.created, NOW), updatedAt: NOW,
      });
      if (status === 'active' || status === 'sold') {
        // trend snapshots over last 6 syncs
        for (let s = 6; s >= 0; s--) {
          const f = (6 - s) / 6;
          docs.fbEng.push({ _id: oid(), listing: _id, reactions: Math.round(reactions * (0.4 + 0.6 * f)), comments: Math.round(comments * (0.4 + 0.6 * f)), shares: Math.round(shares * (0.4 + 0.6 * f)), views: Math.round(views * (0.4 + 0.6 * f)), fetchedAt: daysAgo(s * 4), createdAt: daysAgo(s * 4), updatedAt: daysAgo(s * 4) });
        }
        // a few comments
        const nc = int(0, 3);
        for (let k = 0; k < nc; k++) {
          const replied = chance(0.5);
          const ca = `${pick(FIRST)} ${pick(LAST)}`;
          docs.fbComments.push({
            _id: oid(), listing: _id, connection: fbConn._id, fbCommentId: `${fbConn.pageId}_${int(1000000, 9999999)}_${idx}_${k}`,
            fbPostId: docs.fbListings[docs.fbListings.length - 1].fbPostId, authorName: ca, authorId: String(int(100000000, 999999999)),
            message: pick(['Is this still available?', 'What’s the best price?', 'Any accidents?', 'Can I see it this weekend?', 'Does it come with winter tires?']),
            fbCreatedTime: dateBetween(20, 0), status: replied ? 'replied' : 'new', replyText: replied ? 'Yes! DM us to book a viewing.' : '',
            repliedBy: replied ? pick(allActors)._id : undefined, repliedAt: replied ? dateBetween(15, 0) : undefined, unread: !replied,
            isDeleted: false, createdAt: dateBetween(20, 0), updatedAt: NOW,
          });
        }
      }
      logAct('facebook', status === 'failed' ? 'listing-removed' : 'published', 'FacebookListing', _id, v.title, pick(allActors), { status }, publishedAt || NOW);
    });
  }

  // ── Insert everything ──────────────────────────────────────────────
  await insert('roles', docs.roles);
  await insert('users', docs.users);
  await insert('seller_leads', docs.sellers);
  await insert('vehicles', docs.vehicles);
  await insert('buyer_leads', docs.buyers);
  await insert('leads', docs.leads);
  await insert('sales', docs.sales);
  await insert('expenses', docs.expenses);
  await insert('calendar_events', docs.calendar);
  await insert('communication_logs', docs.comms);
  await insert('loans', docs.loans);
  await insert('ads_insight_snapshots', docs.adsSnaps);
  await insert('facebook_listings', docs.fbListings);
  await insert('facebook_engagement', docs.fbEng);
  await insert('facebook_comments', docs.fbComments);
  await insert('activities', docs.activities);

  // ── Update admin + dealer settings + ad connections ────────────────
  await C('users').updateOne({ _id: admin._id }, { $set: { roleId: roleByName['Admin'], department: 'Management', status: 'active', phone: admin.phone || '(905) 555-0100' } });
  await C('dealer_settings').updateOne({}, {
    $set: {
      dealershipName: 'Maple Leaf Motors', address: '2280 Battleford Rd', city: 'Mississauga', state: 'ON',
      zipCode: 'L5N 0A1', country: 'Canada', phone: '(905) 555-0142', email: 'sales@mapleleafmotors.ca',
      website: 'https://mapleleafmotors.ca', taxId: '81234 5678 RT0001', licenseNumber: 'OMVIC-2024-44871',
      currency: 'CAD', language: 'en', primaryColor: '#C8102E',
    },
  }, { upsert: true });
  for (const conn of [googleConn, metaConn]) {
    if (!conn) continue;
    await C('ads_connections').updateOne({ _id: conn._id }, { $set: { status: 'active', lastError: '', lastSyncedAt: NOW, currency: 'CAD', accountName: conn.provider === 'google' ? 'Maple Leaf Motors — Google Ads' : 'Maple Leaf Motors — Meta Ads' } });
  }

  // ── Summary ────────────────────────────────────────────────────────
  const totalRevenue = docs.sales.reduce((s, x) => s + (x.salePrice - x.discount), 0);
  const totalProfit = docs.sales.reduce((s, x) => s + (x.salePrice - x.discount - x.costPrice - x.totalSpend), 0);
  console.log('\n── Seed complete ──');
  console.log(`roles(custom) ${docs.roles.length} | staff ${docs.users.length} | sellers ${docs.sellers.length} | vehicles ${docs.vehicles.length} (sold ${docs.sales.length})`);
  console.log(`buyers ${docs.buyers.length} | leads ${docs.leads.length} | expenses ${docs.expenses.length} | calendar ${docs.calendar.length} | comms ${docs.comms.length} | loans ${docs.loans.length}`);
  console.log(`activities ${docs.activities.length} | adsSnapshots ${docs.adsSnaps.length} | fbListings ${docs.fbListings.length} | fbEngagement ${docs.fbEng.length} | fbComments ${docs.fbComments.length}`);
  console.log(`revenue $${Math.round(totalRevenue).toLocaleString('en-US')} | gross profit $${Math.round(totalProfit).toLocaleString('en-US')}`);

  await mongoose.disconnect();
  console.log('Done.');
})().catch((e) => { console.error(e); process.exit(1); });
