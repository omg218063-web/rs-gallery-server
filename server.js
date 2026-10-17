const express = require('express'), cors = require('cors'), mongoose = require('mongoose');
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
const { MONGO_URI, ADMIN_PASSWORD } = process.env;

const Product = mongoose.model('Product', new mongoose.Schema({
  n: String, p: Number, o: Number, c: String, e: String, i: { type: String, default: '' }, h: { type: Number, default: 0 }
}, { timestamps: true }));
const Order = mongoose.model('Order', new mongoose.Schema({
  item: String, price: Number, name: String, ph: String, a: String, z: String,
  adv: Number, bk: String, trx: String, st: { type: String, default: 'New' }
}, { timestamps: true }));
const Setting = mongoose.model('Setting', new mongoose.Schema({ _id: String, v: Object }));
const Visit = mongoose.model('Visit', new mongoose.Schema({ _id: String, n: Number }));

const DEF = { bk: '01951639460', wa: '8801951639460', mail: 'omg218063@gmail.com', ph: '01951639460', in: 60, out: 120, pub: '', slot: '', cust: 85, sold: 420 };
const SEED = ("Premium Smart Watch|1800|2500|watch|⌚|1;Classic Gold Watch|2200|3000|watch|🕰️|0;Couple Watch Pair|2600|3500|watch|⌚|1;Ladies Bracelet Watch|1400|2000|watch|⌚|0;" +
"Matte Lipstick Set|650|900|cos|💄|1;Skin Glow Face Kit|1100|1500|cos|🧴|0;Perfume Mist|900|1300|cos|🌸|1;Makeup Palette|1200|1700|cos|🎨|0;" +
"Party Gown|2400|3200|wf|👗|1;Designer Kurti|1300|1700|wf|👚|0;Silk Saree|3200|4200|wf|🥻|1;Hijab Set|700|950|wf|🧕|0;" +
"Cotton Casual Shirt|850|1200|shirt|👔|1;Formal Shirt|950|1300|shirt|👔|0;Polo T-Shirt|700|1000|shirt|👕|1;Denim Shirt|1100|1500|shirt|👕|0;" +
"Sports Sneakers|2100|2800|shoe|👟|1;Leather Loafers|1900|2500|shoe|👞|0;Ladies Heels|1500|2000|shoe|👠|0;Hiking Boots|2300|3000|shoe|🥾|1")
  .split(';').map(s => { const a = s.split('|'); return { n: a[0], p: +a[1], o: +a[2], c: a[3], e: a[4], h: +a[5] }; });

const w = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));
const day = () => new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
const getCfg = async () => { const s = await Setting.findById('cfg'); return { ...DEF, ...(s ? s.v : {}) }; };
const auth = (req, res, next) => {
  if (!ADMIN_PASSWORD || req.headers['x-admin'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.get('/', (req, res) => res.send('RS Gallery API running'));

// Public
app.get('/api/products', w(async (req, res) => res.json(await Product.find().sort({ createdAt: 1 }))));
app.get('/api/config', w(async (req, res) => res.json(await getCfg())));
app.post('/api/visit', w(async (req, res) => {
  await Visit.findByIdAndUpdate(day(), { $inc: { n: 1 } }, { upsert: true });
  res.json({ ok: 1 });
}));
app.post('/api/orders', w(async (req, res) => {
  const { pid, name, ph, a, z, bk, trx } = req.body;
  if (!pid || !name || !ph || !a || !bk || !trx) return res.status(400).json({ error: 'Missing fields' });
  const p = await Product.findById(pid);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const c = await getCfg();
  const inside = z === 'in';
  const o = await Order.create({
    item: p.n, price: p.p, name, ph, a, z: inside ? 'Inside Dhaka' : 'Outside Dhaka',
    adv: inside ? +c.in : +c.out, bk, trx
  });
  res.json({ ok: 1, id: o._id });
}));

// Admin
app.post('/api/admin/login', auth, (req, res) => res.json({ ok: 1 }));
app.get('/api/admin/stats', auth, w(async (req, res) => {
  const orders = await Order.find();
  const t = day(), v = await Visit.findById(t);
  const today = orders.filter(o => new Date(o.createdAt.getTime() + 6 * 3600e3).toISOString().slice(0, 10) === t).length;
  res.json({
    visitors: v ? v.n : 0, ordersToday: today, orders: orders.length,
    sales: orders.reduce((s, o) => s + o.price, 0), advance: orders.reduce((s, o) => s + o.adv, 0)
  });
}));
app.get('/api/admin/orders', auth, w(async (req, res) => res.json(await Order.find().sort({ createdAt: -1 }))));
app.patch('/api/admin/orders/:id', auth, w(async (req, res) => res.json(await Order.findByIdAndUpdate(req.params.id, { st: req.body.st }, { new: true }))));
app.delete('/api/admin/orders/:id', auth, w(async (req, res) => { await Order.findByIdAndDelete(req.params.id); res.json({ ok: 1 }); }));
app.post('/api/admin/products', auth, w(async (req, res) => res.json(await Product.create(req.body))));
app.patch('/api/admin/products/:id', auth, w(async (req, res) => res.json(await Product.findByIdAndUpdate(req.params.id, req.body, { new: true }))));
app.delete('/api/admin/products/:id', auth, w(async (req, res) => { await Product.findByIdAndDelete(req.params.id); res.json({ ok: 1 }); }));
app.put('/api/admin/config', auth, w(async (req, res) => {
  await Setting.findByIdAndUpdate('cfg', { v: req.body }, { upsert: true });
  res.json(await getCfg());
}));

mongoose.connect(MONGO_URI).then(async () => {
  console.log('DB connected');
  if (!(await Product.countDocuments())) await Product.insertMany(SEED);
  app.listen(process.env.PORT || 3000, () => console.log('Server running'));
}).catch(e => { console.error('DB error', e.message); process.exit(1); });
