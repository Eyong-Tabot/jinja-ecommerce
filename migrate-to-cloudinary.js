require('dotenv').config();
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI);

// Product model (copy from your server.js)
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

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Helper: upload a base64 image to Cloudinary
async function uploadBase64ToCloudinary(base64String, productName) {
  return new Promise((resolve, reject) => {
    // Remove the data:image/...;base64, prefix if present
    const base64Data = base64String.includes('base64,') 
      ? base64String.split('base64,')[1] 
      : base64String;
    
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder: 'jinja_products', 
        public_id: `${Date.now()}_${productName.substring(0, 20)}`,
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp']
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    uploadStream.end(Buffer.from(base64Data, 'base64'));
  });
}

async function migrateProducts() {
  try {
    console.log('🔍 Fetching products...');
    const products = await Product.find({});
    console.log(`✅ Found ${products.length} products to process.`);

    let totalConverted = 0;
    let totalSkipped = 0;

    for (const product of products) {
      let updated = false;
      const newImages = [];

      for (const image of product.images) {
        // Check if already a Cloudinary URL
        if (image.startsWith('https://res.cloudinary.com/') || image.startsWith('http://res.cloudinary.com/')) {
          newImages.push(image);
          continue;
        }

        // Check if base64
        if (image.startsWith('data:image/') || image.startsWith('data:application/')) {
          try {
            console.log(`  📤 Uploading image for "${product.name}"...`);
            const cloudinaryUrl = await uploadBase64ToCloudinary(image, product.name);
            newImages.push(cloudinaryUrl);
            totalConverted++;
            updated = true;
            console.log(`  ✅ Uploaded successfully`);
          } catch (error) {
            console.error(`  ❌ Failed to upload image for "${product.name}":`, error.message);
            // Keep the original image if upload fails
            newImages.push(image);
          }
        } else {
          // If it's a URL but not Cloudinary, keep it
          newImages.push(image);
        }
      }

      if (updated) {
        product.images = newImages;
        await product.save();
        console.log(`  💾 Saved updated product: ${product.name}`);
      } else {
        totalSkipped++;
      }
    }

    console.log(`\n🎉 Migration complete!`);
    console.log(`   ✅ Converted: ${totalConverted} images`);
    console.log(`   ⏭️  Skipped (already Cloudinary or not base64): ${totalSkipped} images`);
    console.log(`   📦 Total products processed: ${products.length}`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run the migration
migrateProducts();
