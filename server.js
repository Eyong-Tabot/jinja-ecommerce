require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- DISABLE CACHING FOR ALL REQUESTS (fixes the incognito issue) ---
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

mongoose.connect(process.env.MONGODB_URI);

// ---------- MODELS ----------
const productSchema = new mongoose.Schema({
  name: String,
  description: String,
  priceGHS: Number,
  category: String,
  images: [String],
  inStock: Boolean,
  stockQuantity: Number,
  createdAt: Date
});
const Product = mongoose.model('Product', productSchema);

const cartSchema = new mongoose.Schema({
  cartId: String,
  items: [{ productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, quantity: Number }]
});
const Cart = mongoose.model('Cart', cartSchema);

const adminSchema = new mongoose.Schema({
  email: String,
  password: String
});
adminSchema.pre('save', async function(next) {
  if (this.isModified('password')) this.password = await bcrypt.hash(this.password, 12);
  next();
});
const Admin = mongoose.model('Admin', adminSchema);

const settingSchema = new mongoose.Schema({ key: String, value: mongoose.Schema.Types.Mixed });
const Setting = mongoose.model('Setting', settingSchema);

// Auth middleware
const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error();
    req.adminId = decoded.id;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ---------- PUBLIC ROUTES ----------
app.get('/api/products', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 12;
  const query = {};
  if (req.query.category && req.query.category !== 'all') query.category = req.query.category;
  if (req.query.search) query.name = { $regex: req.query.search, $options: 'i' };
  const products = await Product.find(query).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit);
  const total = await Product.countDocuments(query);
  res.json({ products, currentPage: page, totalPages: Math.ceil(total/limit), totalProducts: total });
});

app.get('/api/categories', async (req, res) => {
  const cats = await Product.distinct('category');
  res.json(cats);
});

// Cart routes
app.get('/api/cart/:cartId', async (req, res) => {
  let cart = await Cart.findOne({ cartId: req.params.cartId }).populate('items.productId');
  if (!cart) cart = new Cart({ cartId: req.params.cartId, items: [] });
  await cart.save();
  res.json(cart);
});

app.post('/api/cart/:cartId/items', async (req, res) => {
  let cart = await Cart.findOne({ cartId: req.params.cartId });
  if (!cart) cart = new Cart({ cartId: req.params.cartId, items: [] });
  const existing = cart.items.find(i => i.productId.toString() === req.body.productId);
  if (existing) existing.quantity += req.body.quantity || 1;
  else cart.items.push({ productId: req.body.productId, quantity: req.body.quantity || 1 });
  await cart.save();
  await cart.populate('items.productId');
  res.json(cart);
});

app.put('/api/cart/:cartId/items/:productId', async (req, res) => {
  const cart = await Cart.findOne({ cartId: req.params.cartId });
  const item = cart.items.find(i => i.productId.toString() === req.params.productId);
  if (req.body.quantity <= 0) cart.items = cart.items.filter(i => i.productId.toString() !== req.params.productId);
  else item.quantity = req.body.quantity;
  await cart.save();
  await cart.populate('items.productId');
  res.json(cart);
});

app.delete('/api/cart/:cartId/items/:productId', async (req, res) => {
  const cart = await Cart.findOne({ cartId: req.params.cartId });
  cart.items = cart.items.filter(i => i.productId.toString() !== req.params.productId);
  await cart.save();
  await cart.populate('items.productId');
  res.json(cart);
});

app.delete('/api/cart/:cartId', async (req, res) => {
  await Cart.findOneAndDelete({ cartId: req.params.cartId });
  res.json({ message: 'cleared' });
});

// ---------- ADMIN ROUTES ----------
app.post('/api/admin/login', async (req, res) => {
  const admin = await Admin.findOne({ email: req.body.email });
  if (!admin || !(await bcrypt.compare(req.body.password, admin.password)))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: admin._id, email: admin.email, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

app.post('/api/admin/change-password', adminAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const admin = await Admin.findById(req.adminId);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  if (!(await bcrypt.compare(oldPassword, admin.password)))
    return res.status(401).json({ error: 'Current password is incorrect' });
  admin.password = newPassword;
  await admin.save();
  res.json({ message: 'Password updated successfully' });
});

app.get('/api/admin/verify', adminAuth, (req, res) => res.json({ valid: true }));

app.post('/api/admin/products', adminAuth, async (req, res) => {
  const { name, description, priceGHS, category, images, inStock, stockQuantity } = req.body;
  const product = new Product({
    name, description,
    priceGHS: parseFloat(priceGHS),
    category,
    images: images || [],
    inStock: inStock === true || inStock === 'true',
    stockQuantity: parseInt(stockQuantity) || 999,
    createdAt: new Date()
  });
  await product.save();
  res.json(product);
});

app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  const { name, description, priceGHS, category, images, inStock, stockQuantity } = req.body;
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  product.name = name;
  product.description = description;
  product.priceGHS = parseFloat(priceGHS);
  product.category = category;
  product.images = images || [];
  product.inStock = inStock === true || inStock === 'true';
  product.stockQuantity = parseInt(stockQuantity) || 999;
  await product.save();
  res.json(product);
});

app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.json({ message: 'deleted' });
});

app.get('/api/admin/products', adminAuth, async (req, res) => {
  const products = await Product.find().sort({ createdAt: -1 });
  res.json(products);
});

app.post('/api/admin/logo', adminAuth, async (req, res) => {
  const { logoBase64 } = req.body;
  await Setting.findOneAndUpdate({ key: 'logo' }, { key: 'logo', value: logoBase64 }, { upsert: true });
  res.json({ logoUrl: logoBase64 });
});

app.get('/api/settings', async (req, res) => {
  const logo = await Setting.findOne({ key: 'logo' });
  res.json({ logoUrl: logo?.value || null });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Create default admin if none exists
const init = async () => {
  const exists = await Admin.findOne({ email: process.env.ADMIN_EMAIL });
  if (!exists) await Admin.create({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
};
init();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
