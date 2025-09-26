const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Initialize Supabase client (using environment variables from main server)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
});

// Rate limiting for featured image uploads
const featuredImageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit featured image uploads to 5 per 15 minutes
  message: { error: 'Too many featured image upload attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Authentication middleware
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];
    
    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      console.log('Authentication error:', error?.message);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// Helper function to delete all existing featured images from Cloudinary
const deleteExistingFeaturedImages = async () => {
  try {
    console.log('🗑️ Deleting existing featured images from Cloudinary...');
    
    // Get all images in the featured_image folder
    const { resources } = await cloudinary.search
      .expression('folder:featured_image')
      .execute();
    
    if (resources && resources.length > 0) {
      console.log(`📁 Found ${resources.length} existing featured images to delete`);
      
      // Delete all found images
      const publicIds = resources.map(resource => resource.public_id);
      const deleteResult = await cloudinary.api.delete_resources(publicIds);
      
      console.log(`✅ Deleted ${Object.keys(deleteResult.deleted).length} images from Cloudinary`);
      return { success: true, deletedCount: Object.keys(deleteResult.deleted).length };
    } else {
      console.log('📭 No existing featured images found to delete');
      return { success: true, deletedCount: 0 };
    }
  } catch (error) {
    console.error('❌ Error deleting existing featured images:', error);
    throw new Error(`Failed to delete existing featured images: ${error.message}`);
  }
};

// Helper function to upload featured image to Cloudinary
const uploadFeaturedImageToCloudinary = (buffer, originalName) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'featured_image', // Specific folder for featured images
        resource_type: 'image',
        transformation: [
          { quality: 'auto:good' },
          { fetch_format: 'auto' },
          { width: 1200, height: 1200, crop: 'limit' }
        ],
        public_id: `featured_${Date.now()}`, // Simple naming for featured image
        overwrite: true, // Allow overwriting
        unique_filename: false // Use our custom public_id
      },
      (error, result) => {
        if (error) {
          console.error('Cloudinary upload error:', error);
          reject(error);
        } else {
          console.log(`✅ Featured image uploaded to Cloudinary: ${result.secure_url}`);
          resolve(result.secure_url);
        }
      }
    );
    
    uploadStream.end(buffer);
  });
};

// Upload featured image endpoint
router.post('/upload', featuredImageLimiter, authenticateUser, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    console.log(`🌟 Uploading featured image for user: ${req.user.id}`);
    console.log(`📁 File size: ${req.file.size} bytes`);
    console.log(`📄 File type: ${req.file.mimetype}`);

    // Step 1: Delete all existing featured images from Cloudinary
    try {
      await deleteExistingFeaturedImages();
    } catch (deleteError) {
      console.error('⚠️ Warning: Failed to delete existing images, but continuing with upload:', deleteError.message);
      // Continue with upload even if deletion fails
    }

    // Step 2: Upload the new featured image
    let imageUrl;
    try {
      imageUrl = await uploadFeaturedImageToCloudinary(req.file.buffer, req.file.originalname);
    } catch (uploadError) {
      console.error('❌ Failed to upload image to Cloudinary:', uploadError);
      return res.status(500).json({ error: 'Failed to upload image to cloud storage' });
    }

    // Step 3: Deactivate all existing featured items in database
    try {
      const { error: deactivateError } = await supabase
        .from('featured_items')
        .update({ is_active: false })
        .eq('is_active', true);

      if (deactivateError) {
        console.error('⚠️ Warning: Failed to deactivate existing featured items:', deactivateError);
        // Continue anyway - the new item will be marked as active
      }
    } catch (dbError) {
      console.error('⚠️ Database deactivation error:', dbError);
    }

    console.log(`✅ Featured image upload completed: ${imageUrl}`);

    res.json({
      success: true,
      imageUrl: imageUrl,
      message: 'Featured image uploaded successfully'
    });

  } catch (error) {
    console.error('❌ Featured image upload error:', error);
    res.status(500).json({ error: 'Server error during featured image upload' });
  }
});

// Get current featured image endpoint
router.get('/current', async (req, res) => {
  try {
    console.log('📥 Fetching current featured image...');

    const { data: featuredItem, error } = await supabase
      .from('featured_items')
      .select('*')
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "no rows returned"
      console.error('❌ Database error fetching featured item:', error);
      return res.status(500).json({ error: 'Failed to fetch current featured item' });
    }

    if (!featuredItem) {
      console.log('📭 No active featured item found');
      return res.json({
        success: true,
        featuredItem: null,
        message: 'No active featured item found'
      });
    }

    console.log(`✅ Found active featured item: ${featuredItem.id}`);

    res.json({
      success: true,
      featuredItem: {
        id: featuredItem.id,
        title: featuredItem.title,
        image_url: featuredItem.image_url,
        author: featuredItem.author,
        category: featuredItem.category,
        likes: featuredItem.likes,
        is_active: featuredItem.is_active,
        created_at: featuredItem.created_at,
        updated_at: featuredItem.updated_at
      }
    });

  } catch (error) {
    console.error('❌ Get current featured image error:', error);
    res.status(500).json({ error: 'Server error fetching current featured item' });
  }
});

// Update featured item details endpoint
router.put('/update', authenticateUser, async (req, res) => {
  try {
    const { title, author, category, likes, image_url } = req.body;

    if (!title || !author || !category || likes === undefined) {
      return res.status(400).json({ error: 'Title, author, category, and likes are required' });
    }

    if (!image_url) {
      return res.status(400).json({ error: 'Image URL is required. Please upload an image first.' });
    }

    console.log(`📝 Updating featured item for user: ${req.user.id}`);

    // First, deactivate all existing featured items
    const { error: deactivateError } = await supabase
      .from('featured_items')
      .update({ is_active: false })
      .eq('is_active', true);

    if (deactivateError) {
      console.error('⚠️ Warning: Failed to deactivate existing items:', deactivateError);
    }

    // Create new featured item or update existing one
    const featuredItemData = {
      title: title.trim(),
      image_url: image_url,
      author: author.trim(),
      category: category.trim(),
      likes: parseInt(likes) || 0,
      is_active: true,
      updated_at: new Date().toISOString(),
      updated_by: req.user.id,
    };

    // Check if there's an existing item with the same image_url
    const { data: existingItem, error: checkError } = await supabase
      .from('featured_items')
      .select('id')
      .eq('image_url', image_url)
      .single();

    let result;
    if (existingItem && !checkError) {
      // Update existing item
      const { data, error } = await supabase
        .from('featured_items')
        .update(featuredItemData)
        .eq('id', existingItem.id)
        .select()
        .single();
      
      result = { data, error };
      console.log(`📝 Updated existing featured item: ${existingItem.id}`);
    } else {
      // Create new item
      featuredItemData.created_at = new Date().toISOString();
      featuredItemData.created_by = req.user.id;
      
      const { data, error } = await supabase
        .from('featured_items')
        .insert(featuredItemData)
        .select()
        .single();
      
      result = { data, error };
      console.log(`✨ Created new featured item: ${data?.id}`);
    }

    if (result.error) {
      console.error('❌ Database error saving featured item:', result.error);
      return res.status(500).json({ error: 'Failed to save featured item' });
    }

    console.log(`✅ Featured item saved successfully: ${result.data.id}`);

    res.json({
      success: true,
      featuredItem: result.data,
      message: 'Featured item saved successfully'
    });

  } catch (error) {
    console.error('❌ Update featured item error:', error);
    res.status(500).json({ error: 'Server error updating featured item' });
  }
});

// Delete featured item endpoint
router.delete('/delete/:id', authenticateUser, async (req, res) => {
  try {
    const { id } = req.params;

    console.log(`🗑️ Deleting featured item: ${id} by user: ${req.user.id}`);

    // First get the item to get the image URL for Cloudinary deletion
    const { data: itemToDelete, error: fetchError } = await supabase
      .from('featured_items')
      .select('image_url')
      .eq('id', id)
      .single();

    if (fetchError || !itemToDelete) {
      return res.status(404).json({ error: 'Featured item not found' });
    }

    // Delete from database
    const { error: deleteError } = await supabase
      .from('featured_items')
      .delete()
      .eq('id', id);

    if (deleteError) {
      console.error('❌ Database deletion error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete featured item from database' });
    }

    // Try to delete from Cloudinary (but don't fail if this doesn't work)
    try {
      if (itemToDelete.image_url && itemToDelete.image_url.includes('cloudinary.com')) {
        // Extract public_id from Cloudinary URL
        const urlParts = itemToDelete.image_url.split('/');
        const publicIdWithExtension = urlParts[urlParts.length - 1];
        const publicId = `featured_image/${publicIdWithExtension.split('.')[0]}`;
        
        await cloudinary.uploader.destroy(publicId);
        console.log(`🗑️ Deleted image from Cloudinary: ${publicId}`);
      }
    } catch (cloudinaryError) {
      console.error('⚠️ Warning: Failed to delete image from Cloudinary:', cloudinaryError.message);
      // Don't fail the request if Cloudinary deletion fails
    }

    console.log(`✅ Featured item deleted successfully: ${id}`);

    res.json({
      success: true,
      message: 'Featured item deleted successfully'
    });

  } catch (error) {
    console.error('❌ Delete featured item error:', error);
    res.status(500).json({ error: 'Server error deleting featured item' });
  }
});

module.exports = router;