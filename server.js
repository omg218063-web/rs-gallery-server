const express = require('express'), cors = require('cors'), mongoose = require('mongoose');
const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));
const { MONGO_URI, ADMIN_PASSWORD } = process.env;
const open = n => mongoose.model(n, new mongoose.Schema({}, { strict: false, timestamps: true }));
const keyed = n => mongoose.model(n, new mongoose.Schema({ _id: String }, { strict: false }));
const Product = open('Product'), Order = open('Order');
const Setting = keyed('Setting'), Visit = keyed('Visit');

const w = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));
const day = (d = Date.now()) => new Date(d + 6 * 3600e3).toISOString().slice(0, 10);
const cfg = async () => { const s = await Setting.findById('cfg').lean(); return s ? s.v : {}; };
const auth = (req, res, next) => {
  if (!ADMIN_PASSWORD || req.headers['x-admin'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  next();
};

// ---- RS Wallet এ ডিপোজিটের খবর পাঠানো ----
async function sendToWallet(data, tries = 3) {
  if (!process.env.WALLET_URL || !process.env.WALLET_KEY) return;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(process.env.WALLET_URL + '/api/site/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.WALLET_KEY },
        body: JSON.stringify(data)
      });
      const out = await r.json().catch(() => ({}));
      if (r.ok && out.ok !== false) return out;
      if (r.status >= 400 && r.status < 500) {
        console.error('Wallet rejected:', r.status, out.error || '');
        return;
      }
      throw new Error('Wallet error ' + r.status);
    } catch (e) {
      console.error('Wallet try ' + i + ':', e.message);
      if (i < tries) await new Promise(ok => setTimeout(ok, 15000));
    }
  }
}

// ---- helpers ----
const strip = p => { if (!p) return p; const { cost, code, ...r } = p; return r; };
const imgUrl = (p, i) => '/api/img/' + p._id + '/' + i + '?v=' + new Date(p.updatedAt || 0).getTime();
const withImg = p => ({ ...p, imgs: p.ni ? [imgUrl(p, 0)] : [] });
const listPipe = (hide) => [
  { $addFields: { ni: { $size: { $cond: [{ $isArray: '$imgs' }, '$imgs', []] } } } },
  { $project: hide },
  { $sort: { createdAt: -1 } }
];
const BAD = ['Returned', 'Cancelled', 'Failed'];
const normPh = s => { let d = String(s || '').replace(/\D/g, ''); if (d.startsWith('880')) d = d.slice(2); if (d.length === 10) d = '0' + d; return d.slice(-11); };
const akey = a => String(a || '').toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]/g, '').slice(0, 40);
// a customer is matched by phone, device id OR address
const history = async (ph, cid, addr) => {
  const or = [], n = normPh(ph), ak = akey(addr);
  if (n.length === 11) or.push({ phn: n });
  if (String(cid || '').length >= 20) or.push({ cid: String(cid) });
  if (ak.length >= 12) or.push({ akey: ak });
  if (!or.length) return { bad: 0, good: 0, total: 0 };
  const os = await Order.find({ $or: or }).select('st').lean();
  return { bad: os.filter(o => BAD.includes(o.st)).length, good: os.filter(o => o.st === 'Delivered').length, total: os.length };
};
const isRisky = (h, c) => { const t = +(c.riskBad ?? 1); return t > 0 && h.bad >= t; };

app.get('/', (req, res) => res.send('RS Gallery API running'));

// product list: tiny JSON, images are separate cached URLs
app.get('/api/products', w(async (req, res) => {
  const l = await Product.aggregate(listPipe({ imgs: 0, cost: 0, code: 0 }));
  res.json(l.map(withImg));
}));
app.get('/api/products/:id', w(async (req, res) => {
  const p = await Product.findById(req.params.id).lean();
  if (!p) return res.status(404).json({ error: 'Not found' });
  const n = (p.imgs || []).length;
  res.json({ ...strip(p), ni: n, imgs: Array.from({ length: n }, (_, i) => imgUrl(p, i)) });
}));
app.get('/api/img/:id/:i', async (req, res) => {
  try {
    const p = await Product.findById(req.params.id).select('imgs').lean();
    const d = p && p.imgs && p.imgs[+req.params.i];
    const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(d || '');
    if (!m) return res.status(404).end();
    res.set({ 'Content-Type': m[1], 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.send(Buffer.from(m[2], 'base64'));
  } catch (e) { res.status(404).end(); }
});
app.get('/api/config', w(async (req, res) => res.json(await cfg())));
app.post('/api/visit', w(async (req, res) => {
  await Visit.findByIdAndUpdate(day(), { $inc: { n: 1 } }, { upsert: true });
  const r = String((req.body || {}).ref || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
  if (r) await Visit.findByIdAndUpdate('r:' + r, { $inc: { n: 1 } }, { upsert: true });
  res.json({ ok: 1 });
}));
app.get('/api/risk', w(async (req, res) => {
  const c = await cfg(), h = await history(req.query.ph, req.query.cid, req.query.addr);
  res.json({ risky: isRisky(h, c) });
}));

// Orders
app.post('/api/orders', w(async (req, res) => {
  const b = req.body, its = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
  if (!its.length || !b.name || !b.ph || !b.a) return res.status(400).json({ error: 'Missing fields' });
  const c = await cfg(), inside = b.z === 'in', base = inside ? +(c.in || 60) : +(c.out || 120);
  const minO = +(c.minOrder ?? 300), freeD = +(c.freeDel ?? 3000);
  let items = [], price = 0, charge = false, profit = 0;
  for (const it of its) {
    const p = await Product.findById(it.pid).lean();
    if (!p) continue;
    const q = Math.max(1, Math.min(+it.qty || 1, 20)), amt = p.p * q;
    items.push({ pid: it.pid, name: p.n, qty: q, size: it.size || '', color: it.color || '', amt, dm: p.dm || 'charge', code: p.code || '' });
    price += amt;
    if (p.cost > 0) profit += (p.p - p.cost) * q;
    if (p.dm !== 'cod') charge = true;
  }
  if (!items.length) return res.status(404).json({ error: 'Products not found' });
  if (price < minO) return res.status(400).json({ error: 'Minimum order is ৳' + minO });
  const h = await history(b.ph, b.cid, b.a), risky = isRisky(h, c);
  const free = freeD > 0 && price >= freeD && !risky;
  const del = free ? 0 : base, adv = (charge || risky) ? del : 0;
  if (adv > 0 && (!b.bk || !b.trx)) return res.status(402).json({ error: 'Advance delivery charge required', risk: risky, adv });
  const o = await Order.create({
    items, price, profit, delivery: adv, adv, due: price,
    item: items.map(i => i.name + (i.size || i.color ? ' (' + [i.size, i.color].filter(Boolean).join('/') + ')' : '') + ' x' + i.qty).join(', '),
    name: b.name, ph: b.ph, phn: normPh(b.ph), a: b.a, akey: akey(b.a), z: inside ? 'Inside Dhaka' : 'Outside Dhaka',
    bk: b.bk || '', trx: b.trx || '', cid: String(b.cid || ''), st: 'New',
    prevBad: h.bad, prevGood: h.good, prevTotal: h.total, risky
  });
  for (const i of items) await Product.updateOne({ _id: i.pid }, { $inc: { sold: i.qty } });
  // অগ্রিম ডেলিভারি চার্জ থাকলে RS Wallet এ পেন্ডিং হিসেবে পাঠাও (ব্যাকগ্রাউন্ডে, অর্ডার আটকাবে না)
  if (adv > 0 && b.trx) {
    sendToWallet({
      trxId: String(b.trx).trim(),
      amount: adv,
      number: String(b.bk || ''),
      orderRef: String(o._id)
    }).catch(e => console.error('Wallet:', e.message));
  }
  res.json({ ok: 1, id: o._id });
}));
app.get('/api/my-orders', w(async (req, res) => {
  const c = String(req.query.cid || '');
  if (c.length < 20) return res.json([]);
  res.json(await Order.find({ cid: c }).sort({ createdAt: -1 }).select('item price adv st createdAt').lean());
}));

// Admin
app.post('/api/admin/login', auth, (req, res) => res.json({ ok: 1 }));
app.get('/api/admin/stats', auth, w(async (req, res) => {
  const os = await Order.find().lean(), t = day(), v = await Visit.findById(t).lean();
  const refs = await Visit.find({ _id: /^r:/ }).lean();
  res.json({
    visitors: v ? v.n : 0, ordersToday: os.filter(o => day(new Date(o.createdAt).getTime()) === t).length,
    orders: os.length, sales: os.reduce((s, o) => s + (o.price || 0), 0), advance: os.reduce((s, o) => s + (o.adv || 0), 0),
    profit: os.reduce((s, o) => s + (o.profit || 0), 0), bad: os.filter(o => BAD.includes(o.st)).length,
    refs: refs.map(r => ({ name: r._id.slice(2), n: r.n })).sort((a, b) => b.n - a.n)
  });
}));
app.get('/api/admin/orders', auth, w(async (req, res) => res.json(await Order.find().sort({ createdAt: -1 }).lean())));
app.patch('/api/admin/orders/:id', auth, w(async (req, res) => res.json(await Order.findByIdAndUpdate(req.params.id, { st: req.body.st }, { new: true }))));
app.delete('/api/admin/orders/:id', auth, w(async (req, res) => { await Order.findByIdAndDelete(req.params.id); res.json({ ok: 1 }); }));
app.get('/api/admin/risky', auth, w(async (req, res) => {
  const os = await Order.find({ phn: { $exists: true, $ne: '' } }).select('name ph phn st').lean(), m = {};
  for (const o of os) {
    const r = m[o.phn] || (m[o.phn] = { name: o.name, ph: o.ph, bad: 0, good: 0, total: 0 });
    r.total++;
    if (BAD.includes(o.st)) r.bad++;
    if (o.st === 'Delivered') r.good++;
  }
  res.json(Object.values(m).filter(r => r.bad > 0).sort((a, b) => b.bad - a.bad));
}));
app.get('/api/admin/products', auth, w(async (req, res) => {
  const l = await Product.aggregate(listPipe({ imgs: 0 }));
  res.json(l.map(withImg));
}));
app.get('/api/admin/products/:id', auth, w(async (req, res) => res.json(await Product.findById(req.params.id).lean())));
app.post('/api/admin/products', auth, w(async (req, res) => res.json(await Product.create(req.body))));
app.patch('/api/admin/products/:id', auth, w(async (req, res) => res.json(await Product.findByIdAndUpdate(req.params.id, req.body, { new: true }))));
app.delete('/api/admin/products/:id', auth, w(async (req, res) => { await Product.findByIdAndDelete(req.params.id); res.json({ ok: 1 }); }));
app.put('/api/admin/config', auth, w(async (req, res) => {
  await Setting.findByIdAndUpdate('cfg', { v: req.body }, { upsert: true });
  res.json(await cfg());
}));

mongoose.connect(MONGO_URI).then(() => {
  console.log('DB connected');
  app.listen(process.env.PORT || 3000, () => console.log('Server running'));
}).catch(e => { console.error('DB error', e.message); process.exit(1); }); // ---------- অ্যাসিস্ট্যান্টের জন্য (শুধু দেখা, কিছু বদলায় না) ----------
const assistantSame = (a, b) => {
  const c = require('crypto');
  const ha = c.createHash('sha256').update(String(a)).digest();
  const hb = c.createHash('sha256').update(String(b)).digest();
  return c.timingSafeEqual(ha, hb);
};

app.get('/api/assistant/summary', w(async (req, res) => {
  const key = String(req.headers['x-assistant-key'] || '');
  const expected = process.env.ASSISTANT_KEY || '';
  if (!expected || !key || !assistantSame(key, expected)) {
    return res.status(401).json({ ok: false, error: 'অনুমতি নেই' });
  }
  const start = new Date(day() + 'T00:00:00+06:00');

  const productTotal = await Product.countDocuments();
  const soldAgg = await Product.aggregate([
    { $group: { _id: null, units: { $sum: { $ifNull: ['$sold', 0] } } } }
  ]);
  const topSelling = await Product.find().sort({ sold: -1 }).limit(5).select('n p sold -_id').lean();

  const statusRows = await Order.aggregate([
    { $group: { _id: '$st', count: { $sum: 1 }, amount: { $sum: { $ifNull: ['$price', 0] } } } }
  ]);
  const byStatus = {};
  statusRows.forEach(r => { byStatus[r._id || 'Unknown'] = { count: r.count, amount: r.amount }; });

  const totals = await Order.aggregate([
    { $group: {
      _id: null,
      orders: { $sum: 1 },
      sales: { $sum: { $ifNull: ['$price', 0] } },
      advance: { $sum: { $ifNull: ['$adv', 0] } },
      profit: { $sum: { $ifNull: ['$profit', 0] } }
    } }
  ]);
  const t = totals[0] || { orders: 0, sales: 0, advance: 0, profit: 0 };

  const todayAgg = await Order.aggregate([
    { $match: { createdAt: { $gte: start } } },
    { $group: { _id: null, count: { $sum: 1 }, sales: { $sum: { $ifNull: ['$price', 0] } } } }
  ]);
  const td = todayAgg[0] || { count: 0, sales: 0 };

  const recent = await Order.find().sort({ createdAt: -1 }).limit(5)
    .select('name item price st createdAt -_id').lean();

  const custAgg = await Order.aggregate([
    { $match: { phn: { $exists: true, $ne: '' } } },
    { $group: { _id: '$phn', n: { $sum: 1 } } },
    { $group: { _id: null, total: { $sum: 1 }, repeat: { $sum: { $cond: [{ $gte: ['$n', 2] }, 1, 0] } } } }
  ]);
  const cu = custAgg[0] || { total: 0, repeat: 0 };

  const visit = await Visit.findById(day()).lean();

  res.json({
    ok: true,
    date: day(),
    products: { total: productTotal, unitsSold: soldAgg[0] ? soldAgg[0].units : 0, topSelling: topSelling },
    orders: {
      total: t.orders,
      totalSales: t.sales,
      totalAdvanceCharge: t.advance,
      totalProfit: t.profit,
      byStatus: byStatus,
      today: { count: td.count, sales: td.sales },
      recent: recent
    },
    customers: { uniqueByPhone: cu.total, repeatCustomers: cu.repeat },
    visitorsToday: visit ? visit.n : 0
  });
}));
