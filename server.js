const express = require('express'), cors = require('cors'), mongoose = require('mongoose');
const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));
const { MONGO_URI, ADMIN_PASSWORD } = process.env;
const open = n => mongoose.model(n, new mongoose.Schema({}, { strict: false, timestamps: true }));
const keyed = n => mongoose.model(n, new mongoose.Schema({ _id: String }, { strict: false }));
const Product = open('Product'), Order = open('Order'), Setting = keyed('Setting'), Visit = keyed('Visit');

const w = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));
const day = (d = Date.now()) => new Date(d + 6 * 3600e3).toISOString().slice(0, 10);
const cfg = async () => { const s = await Setting.findById('cfg').lean(); return s ? s.v : {}; };
const auth = (req, res, next) => {
  if (!ADMIN_PASSWORD || req.headers['x-admin'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  next();
};

app.get('/', (req, res) => res.send('RS Gallery API running'));
app.get('/api/products', w(async (req, res) => res.json(await Product.find().sort({ createdAt: -1 }).lean())));
app.get('/api/config', w(async (req, res) => res.json(await cfg())));
app.post('/api/visit', w(async (req, res) => {
  await Visit.findByIdAndUpdate(day(), { $inc: { n: 1 } }, { upsert: true });
  res.json({ ok: 1 });
}));
app.post('/api/orders', w(async (req, res) => {
  const b = req.body;
  if (!b.pid || !b.name || !b.ph || !b.a || !b.bk || !b.trx) return res.status(400).json({ error: 'Missing fields' });
  const p = await Product.findById(b.pid).lean();
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const c = await cfg(), q = Math.max(1, Math.min(+b.qty || 1, 20)), inside = b.z === 'in';
  const o = await Order.create({
    item: p.n, pid: b.pid, qty: q, size: b.size || '', color: b.color || '', price: p.p * q,
    name: b.name, ph: b.ph, a: b.a, z: inside ? 'Inside Dhaka' : 'Outside Dhaka',
    adv: inside ? +(c.in || 60) : +(c.out || 120), bk: b.bk, trx: b.trx, st: 'New'
  });
  res.json({ ok: 1, id: o._id });
}));

app.post('/api/admin/login', auth, (req, res) => res.json({ ok: 1 }));
app.get('/api/admin/stats', auth, w(async (req, res) => {
  const os = await Order.find().lean(), t = day(), v = await Visit.findById(t).lean();
  res.json({
    visitors: v ? v.n : 0, ordersToday: os.filter(o => day(new Date(o.createdAt).getTime()) === t).length,
    orders: os.length, sales: os.reduce((s, o) => s + (o.price || 0), 0), advance: os.reduce((s, o) => s + (o.adv || 0), 0)
  });
}));
app.get('/api/admin/orders', auth, w(async (req, res) => res.json(await Order.find().sort({ createdAt: -1 }).lean())));
app.patch('/api/admin/orders/:id', auth, w(async (req, res) => res.json(await Order.findByIdAndUpdate(req.params.id, { st: req.body.st }, { new: true }))));
app.delete('/api/admin/orders/:id', auth, w(async (req, res) => { await Order.findByIdAndDelete(req.params.id); res.json({ ok: 1 }); }));
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
}).catch(e => { console.error('DB error', e.message); process.exit(1); });
