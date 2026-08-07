require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Disable caching
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'jinja_products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 800, height: 800, crop: 'limit' }]
  }
});
const upload = multer({ storage });

// MongoDB connection
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
  const limit = parseInt(req.query.limit) || 6;
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
// Login: email only (no password)
app.post('/api/admin/login', async (req, res) => {
  const { email } = req.body;
  const admin = await Admin.findOne({ email });
  if (!admin) {
    return res.status(401).json({ error: 'Invalid email' });
  }
  // No password check – email is enough
  const token = jwt.sign({ id: admin._id, email: admin.email, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

app.get('/api/admin/verify', adminAuth, (req, res) => res.json({ valid: true }));

// Add product – upload images to Cloudinary
app.post('/api/admin/products', adminAuth, upload.array('images', 5), async (req, res) => {
  const images = req.files.map(file => file.path);
  const product = new Product({
    name: req.body.name,
    description: req.body.description,
    priceGHS: parseFloat(req.body.priceGHS),
    category: req.body.category,
    images: images,
    inStock: req.body.inStock === 'true',
    stockQuantity: parseInt(req.body.stockQuantity) || 999,
    createdAt: new Date()
  });
  await product.save();
  res.json(product);
});

// Edit product – handle existing images + new uploads
app.put('/api/admin/products/:id', adminAuth, upload.array('images', 5), async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  
  let images = req.body.existingImages ? JSON.parse(req.body.existingImages) : [];
  if (req.files) {
    const newImages = req.files.map(file => file.path);
    images = images.concat(newImages);
  }
  
  product.name = req.body.name;
  product.description = req.body.description;
  product.priceGHS = parseFloat(req.body.priceGHS);
  product.category = req.body.category;
  product.images = images;
  product.inStock = req.body.inStock === 'true';
  product.stockQuantity = parseInt(req.body.stockQuantity) || 999;
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

// Logo upload – Cloudinary
app.post('/api/admin/logo', adminAuth, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const logoUrl = req.file.path;
  await Setting.findOneAndUpdate({ key: 'logo' }, { key: 'logo', value: logoUrl }, { upsert: true });
  res.json({ logoUrl });
});

app.get('/api/settings', async (req, res) => {
  const logo = await Setting.findOne({ key: 'logo' });
  res.json({ logoUrl: logo?.value || null });
});

// Ping endpoint for uptime
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Create default admin if none exists (password is set but not used)
const init = async () => {
  const exists = await Admin.findOne({ email: process.env.ADMIN_EMAIL });
  if (!exists) {
    await Admin.create({ email: process.env.ADMIN_EMAIL, password: Math.random().toString(36) });
  }
};
init();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
