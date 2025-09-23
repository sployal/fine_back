const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const router = express.Router();

// Initialize Supabase client (same as main server)
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

// Configure Cloudinary (same as main server)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Rate limiting for image sending - FIXED for proxy environment
const imageSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit to 5 image sends per 15 minutes
  message: { error: 'Too many image send attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // More lenient - don't count successful requests
  skipFailedRequests: false, // Count failed requests
  // The trust proxy setting from the main app will handle IP detection
  // No need for custom keyGenerator
});

// Configure multer for multiple image uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 10 // Max 10 files
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
});

// Authentication middleware (same logic as main server)
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

// Helper function to upload image to Cloudinary
const uploadImageToCloudinary = (buffer, originalName, senderId, recipientId) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'sent_images',
        resource_type: 'image',
        transformation: [
          { quality: 'auto:good' },
          { fetch_format: 'auto' },
          { width: 1920, height: 1920, crop: 'limit' }
        ],
        public_id: `sent_${senderId}_to_${recipientId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      },
      (error, result) => {
        if (error) {
          console.error('Cloudinary upload error:', error);
          reject(error);
        } else {
          resolve(result);
        }
      }
    );
    
    uploadStream.end(buffer);
  });
};

// Helper function to validate user exists
const validateUserExists = async (userId) => {
  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, display_name, username')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return { exists: false, user: null };
    }

    return { exists: true, user: profile };
  } catch (error) {
    console.error('Error validating user:', error);
    return { exists: false, user: null };
  }
};

// Main endpoint to send images - Updated for new schema
router.post('/send', imageSendLimiter, authenticateUser, upload.array('images', 10), async (req, res) => {
  try {
    const { recipient_id, title, description, is_payment_required } = req.body;
    const senderId = req.user.id;

    console.log(`📤 Image send request: ${req.files?.length || 0} images from ${senderId} to ${recipient_id}`);

    // Validation
    if (!recipient_id) {
      return res.status(400).json({ error: 'Recipient ID is required' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }

    if (req.files.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 images allowed per send' });
    }

    if (senderId === recipient_id) {
      return res.status(400).json({ error: 'Cannot send images to yourself' });
    }

    // Validate recipient exists
    const recipientValidation = await validateUserExists(recipient_id);
    if (!recipientValidation.exists) {
      return res.status(404).json({ error: 'Recipient user not found' });
    }

    console.log(`✅ Sending ${req.files.length} images to: ${recipientValidation.user.display_name || recipientValidation.user.username || 'Unknown'}`);

    // Upload images to Cloudinary
    const uploadPromises = req.files.map(file => 
      uploadImageToCloudinary(file.buffer, file.originalname, senderId, recipient_id)
    );

    let uploadResults;
    try {
      uploadResults = await Promise.all(uploadPromises);
      console.log(`📁 Successfully uploaded ${uploadResults.length} images to Cloudinary`);
    } catch (uploadError) {
      console.error('Failed to upload images:', uploadError);
      return res.status(500).json({ error: 'Failed to upload images to cloud storage' });
    }

    // Step 1: Create photo collection record
    const { data: photoRecord, error: photoError } = await supabase
      .from('photos')
      .insert([{
        sender_id: senderId,
        recipient_id: recipient_id,
        title: title || null,
        description: description || null,
        is_payment_required: is_payment_required === 'true' || is_payment_required === true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (photoError) {
      console.error('Failed to create photos record:', photoError);
      return res.status(500).json({ error: 'Failed to create photo collection' });
    }

    console.log(`📝 Created photo collection: ${photoRecord.id}`);

    // Step 2: Create individual image records
    const imageRecords = uploadResults.map((result, index) => ({
      photo_collection_id: photoRecord.id,
      image_url: result.secure_url,
      file_name: result.original_filename || `image_${index + 1}`,
      file_size: result.bytes,
      mime_type: result.format ? `image/${result.format}` : 'image/jpeg',
      status: photoRecord.is_payment_required ? 'unpaid' : 'paid',
      order_index: index,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));

    const { data: insertedImages, error: imagesError } = await supabase
      .from('images')
      .insert(imageRecords)
      .select();

    if (imagesError) {
      console.error('Failed to create image records:', imagesError);
      // Clean up: delete the photo record if image insertion failed
      await supabase.from('photos').delete().eq('id', photoRecord.id);
      return res.status(500).json({ error: 'Failed to save images to database' });
    }

    console.log(`📝 Created ${insertedImages.length} image records`);

    // Get sender profile for response
    const { data: senderProfile } = await supabase
      .from('profiles')
      .select('display_name, username')
      .eq('id', senderId)
      .single();

    const senderName = senderProfile?.display_name || senderProfile?.username || 'Someone';
    const recipientName = recipientValidation.user.display_name || recipientValidation.user.username || 'Unknown';

    console.log(`✅ Successfully sent ${insertedImages.length} images from ${senderName} to ${recipientName}`);

    // Response matching Flutter app expectations
    res.status(200).json({
      success: true,
      message: `${insertedImages.length} images sent successfully to ${recipientName}`,
      data: {
        photo_collection_id: photoRecord.id,
        sender_id: senderId,
        recipient_id: recipient_id,
        images_sent: insertedImages.length,
        title: photoRecord.title,
        description: photoRecord.description,
        is_payment_required: photoRecord.is_payment_required,
        recipient_name: recipientName,
        sender_name: senderName,
        created_at: photoRecord.created_at,
        updated_at: photoRecord.updated_at,
        images: insertedImages.map(img => ({
          id: img.id,
          image_url: img.image_url,
          status: img.status,
          order_index: img.order_index
        }))
      }
    });

  } catch (error) {
    console.error('Send images error:', error);
    res.status(500).json({ error: 'Server error during image send' });
  }
});

// Get sent images for a user (images they sent) - Updated for new schema
router.get('/sent', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    // Get photo collections with aggregated image counts
    const { data: sentPhotos, error, count } = await supabase
      .from('photos')
      .select(`
        id,
        recipient_id,
        title,
        description,
        is_payment_required,
        created_at,
        updated_at,
        profiles:recipient_id (
          display_name,
          username,
          avatar_url
        )
      `, { count: 'exact' })
      .eq('sender_id', userId)
      .order('updated_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) {
      console.error('Error fetching sent photos:', error);
      return res.status(500).json({ error: 'Failed to fetch sent images' });
    }

    // Get image counts for each photo collection
    const photoIds = sentPhotos.map(photo => photo.id);
    const { data: imageCounts } = await supabase
      .from('images')
      .select('photo_collection_id, status')
      .in('photo_collection_id', photoIds);

    // Group counts by photo collection
    const countsMap = {};
    imageCounts?.forEach(img => {
      if (!countsMap[img.photo_collection_id]) {
        countsMap[img.photo_collection_id] = { paid: 0, unpaid: 0, total: 0 };
      }
      countsMap[img.photo_collection_id][img.status]++;
      countsMap[img.photo_collection_id].total++;
    });

    const formattedPhotos = sentPhotos.map(photo => ({
      id: photo.id,
      recipient_id: photo.recipient_id,
      recipient_name: photo.profiles?.display_name || photo.profiles?.username || 'Unknown',
      recipient_avatar: photo.profiles?.avatar_url,
      title: photo.title,
      description: photo.description,
      total_images: countsMap[photo.id]?.total || 0,
      paid_images_count: countsMap[photo.id]?.paid || 0,
      unpaid_images_count: countsMap[photo.id]?.unpaid || 0,
      is_payment_required: photo.is_payment_required,
      created_at: photo.created_at,
      updated_at: photo.updated_at
    }));

    res.json({
      success: true,
      sent_photos: formattedPhotos,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        hasMore: (offset + parseInt(limit)) < (count || 0)
      }
    });

  } catch (error) {
    console.error('Get sent images error:', error);
    res.status(500).json({ error: 'Server error fetching sent images' });
  }
});

// Get received images for a user (images sent to them) - Updated for new schema
router.get('/received', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    // Get photo collections sent to this user
    const { data: receivedPhotos, error, count } = await supabase
      .from('photos')
      .select(`
        id,
        sender_id,
        title,
        description,
        is_payment_required,
        created_at,
        updated_at,
        profiles:sender_id (
          display_name,
          username,
          avatar_url
        )
      `, { count: 'exact' })
      .eq('recipient_id', userId)
      .order('updated_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) {
      console.error('Error fetching received photos:', error);
      return res.status(500).json({ error: 'Failed to fetch received images' });
    }

    // Get image details for each photo collection
    const photoIds = receivedPhotos.map(photo => photo.id);
    const { data: allImages } = await supabase
      .from('images')
      .select('photo_collection_id, image_url, status, order_index')
      .in('photo_collection_id', photoIds)
      .order('order_index', { ascending: true });

    // Group images by photo collection
    const imagesMap = {};
    const countsMap = {};
    
    allImages?.forEach(img => {
      if (!imagesMap[img.photo_collection_id]) {
        imagesMap[img.photo_collection_id] = { paid: [], unpaid: [] };
        countsMap[img.photo_collection_id] = { paid: 0, unpaid: 0, total: 0 };
      }
      imagesMap[img.photo_collection_id][img.status].push(img.image_url);
      countsMap[img.photo_collection_id][img.status]++;
      countsMap[img.photo_collection_id].total++;
    });

    const formattedPhotos = receivedPhotos.map(photo => ({
      id: photo.id,
      sender_id: photo.sender_id,
      sender_name: photo.profiles?.display_name || photo.profiles?.username || 'Unknown',
      sender_avatar: photo.profiles?.avatar_url,
      title: photo.title,
      description: photo.description,
      total_images: countsMap[photo.id]?.total || 0,
      paid_images_count: countsMap[photo.id]?.paid || 0,
      unpaid_images_count: countsMap[photo.id]?.unpaid || 0,
      is_payment_required: photo.is_payment_required,
      created_at: photo.created_at,
      updated_at: photo.updated_at,
      // Only show paid images URLs, keep unpaid images hidden
      paid_images: imagesMap[photo.id]?.paid || [],
      has_unpaid_images: (countsMap[photo.id]?.unpaid || 0) > 0
    }));

    res.json({
      success: true,
      received_photos: formattedPhotos,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        hasMore: (offset + parseInt(limit)) < (count || 0)
      }
    });

  } catch (error) {
    console.error('Get received images error:', error);
    res.status(500).json({ error: 'Server error fetching received images' });
  }
});

// Get specific photo collection details
router.get('/collection/:id', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const collectionId = req.params.id;

    // Get photo collection details
    const { data: photoCollection, error: photoError } = await supabase
      .from('photos')
      .select(`
        id,
        sender_id,
        recipient_id,
        title,
        description,
        is_payment_required,
        created_at,
        updated_at,
        sender:sender_id (display_name, username, avatar_url),
        recipient:recipient_id (display_name, username, avatar_url)
      `)
      .eq('id', collectionId)
      .single();

    if (photoError || !photoCollection) {
      return res.status(404).json({ error: 'Photo collection not found' });
    }

    // Check if user has access to this collection
    const hasAccess = photoCollection.sender_id === userId || photoCollection.recipient_id === userId;
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this photo collection' });
    }

    // Get images in the collection
    const { data: images, error: imagesError } = await supabase
      .from('images')
      .select('id, image_url, file_name, file_size, status, order_index, created_at')
      .eq('photo_collection_id', collectionId)
      .order('order_index', { ascending: true });

    if (imagesError) {
      console.error('Error fetching collection images:', imagesError);
      return res.status(500).json({ error: 'Failed to fetch collection images' });
    }

    // Filter images based on user role and payment status
    let visibleImages = images;
    if (photoCollection.recipient_id === userId && photoCollection.is_payment_required) {
      // Recipients can only see paid images if payment is required
      visibleImages = images.filter(img => img.status === 'paid');
    }

    res.json({
      success: true,
      collection: {
        id: photoCollection.id,
        sender_id: photoCollection.sender_id,
        recipient_id: photoCollection.recipient_id,
        title: photoCollection.title,
        description: photoCollection.description,
        is_payment_required: photoCollection.is_payment_required,
        created_at: photoCollection.created_at,
        updated_at: photoCollection.updated_at,
        sender_name: photoCollection.sender?.display_name || photoCollection.sender?.username || 'Unknown',
        sender_avatar: photoCollection.sender?.avatar_url,
        recipient_name: photoCollection.recipient?.display_name || photoCollection.recipient?.username || 'Unknown',
        recipient_avatar: photoCollection.recipient?.avatar_url,
        total_images: images.length,
        paid_images_count: images.filter(img => img.status === 'paid').length,
        unpaid_images_count: images.filter(img => img.status === 'unpaid').length,
        visible_images: visibleImages.length,
        images: visibleImages
      }
    });

  } catch (error) {
    console.error('Get collection details error:', error);
    res.status(500).json({ error: 'Server error fetching collection details' });
  }
});

// Update payment status of images in a collection (for recipients)
router.post('/collection/:id/pay', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const collectionId = req.params.id;

    // Verify this is the recipient of the collection
    const { data: photoCollection, error: photoError } = await supabase
      .from('photos')
      .select('id, recipient_id, is_payment_required')
      .eq('id', collectionId)
      .eq('recipient_id', userId)
      .single();

    if (photoError || !photoCollection) {
      return res.status(404).json({ error: 'Photo collection not found or access denied' });
    }

    if (!photoCollection.is_payment_required) {
      return res.status(400).json({ error: 'This collection does not require payment' });
    }

    // Update all unpaid images to paid status
    const { data: updatedImages, error: updateError } = await supabase
      .from('images')
      .update({ 
        status: 'paid',
        updated_at: new Date().toISOString()
      })
      .eq('photo_collection_id', collectionId)
      .eq('status', 'unpaid')
      .select();

    if (updateError) {
      console.error('Error updating payment status:', updateError);
      return res.status(500).json({ error: 'Failed to update payment status' });
    }

    res.json({
      success: true,
      message: `Payment processed. ${updatedImages?.length || 0} images are now accessible.`,
      data: {
        collection_id: collectionId,
        images_unlocked: updatedImages?.length || 0
      }
    });

  } catch (error) {
    console.error('Payment processing error:', error);
    res.status(500).json({ error: 'Server error processing payment' });
  }
});

module.exports = router;