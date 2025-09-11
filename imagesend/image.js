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

// Rate limiting for image sending - FIXED VERSION
const imageSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit to 5 image sends per 15 minutes
  message: { error: 'Too many image send attempts, please try again later.' },
  // Add these options to handle proxy correctly
  trustProxy: true, // Trust the reverse proxy
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Custom key generator to handle proxy IPs properly
  keyGenerator: (req) => {
    // Use the real IP from the proxy, fallback to connection IP
    return req.ip || req.connection.remoteAddress || 'unknown';
  },
  // Skip rate limiting for successful requests to be more lenient
  skipSuccessfulRequests: true,
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

// Helper function to upload image to Cloudinary (specialized for sent images)
const uploadImageToCloudinary = (buffer, originalName, senderId, recipientId) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'sent_images', // Different folder for sent images
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
          resolve(result.secure_url);
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

// Main endpoint to send images
router.post('/send', imageSendLimiter, authenticateUser, upload.array('images', 10), async (req, res) => {
  try {
    const { recipient_id } = req.body;
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

    let imageUrls;
    try {
      imageUrls = await Promise.all(uploadPromises);
      console.log(`📁 Successfully uploaded ${imageUrls.length} images to Cloudinary`);
    } catch (uploadError) {
      console.error('Failed to upload images:', uploadError);
      return res.status(500).json({ error: 'Failed to upload images to cloud storage' });
    }

    // Check if there's an existing photos record for this sender-recipient pair
    const { data: existingRecord } = await supabase
      .from('photos')
      .select('id, unpaid_images')
      .eq('sender_id', senderId)
      .eq('recipient_id', recipient_id)
      .single();

    let photoRecord;

    if (existingRecord) {
      // Update existing record by adding new images to unpaid_images array
      const updatedUnpaidImages = [...(existingRecord.unpaid_images || []), ...imageUrls];
      
      const { data: updatedRecord, error: updateError } = await supabase
        .from('photos')
        .update({
          unpaid_images: updatedUnpaidImages,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingRecord.id)
        .select()
        .single();

      if (updateError) {
        console.error('Failed to update photos record:', updateError);
        return res.status(500).json({ error: 'Failed to save images to database' });
      }

      photoRecord = updatedRecord;
      console.log(`📝 Updated existing photos record: ${photoRecord.id}`);
    } else {
      // Create new photos record
      const { data: newRecord, error: insertError } = await supabase
        .from('photos')
        .insert([{
          sender_id: senderId,
          recipient_id: recipient_id,
          unpaid_images: imageUrls,
          paid_images: [],
          is_payment_required: true,
          created_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (insertError) {
        console.error('Failed to create photos record:', insertError);
        return res.status(500).json({ error: 'Failed to save images to database' });
      }

      photoRecord = newRecord;
      console.log(`📝 Created new photos record: ${photoRecord.id}`);
    }

    // Get sender profile for response
    const { data: senderProfile } = await supabase
      .from('profiles')
      .select('display_name, username')
      .eq('id', senderId)
      .single();

    const senderName = senderProfile?.display_name || senderProfile?.username || 'Someone';
    const recipientName = recipientValidation.user.display_name || recipientValidation.user.username || 'Unknown';

    console.log(`✅ Successfully sent ${imageUrls.length} images from ${senderName} to ${recipientName}`);

    // Response matching Flutter app expectations
    res.status(200).json({
      success: true,
      message: `${imageUrls.length} images sent successfully to ${recipientName}`,
      data: {
        photos_id: photoRecord.id,
        sender_id: senderId,
        recipient_id: recipient_id,
        images_sent: imageUrls.length,
        total_unpaid_images: photoRecord.unpaid_images_count || photoRecord.unpaid_images?.length || 0,
        total_paid_images: photoRecord.paid_images_count || photoRecord.paid_images?.length || 0,
        recipient_name: recipientName,
        sender_name: senderName,
        created_at: photoRecord.created_at,
        updated_at: photoRecord.updated_at
      }
    });

  } catch (error) {
    console.error('Send images error:', error);
    res.status(500).json({ error: 'Server error during image send' });
  }
});

// Get sent images for a user (images they sent)
router.get('/sent', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const { data: sentPhotos, error, count } = await supabase
      .from('photos')
      .select(`
        id,
        recipient_id,
        paid_images,
        unpaid_images,
        total_images_count,
        paid_images_count,
        unpaid_images_count,
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

    const formattedPhotos = sentPhotos.map(photo => ({
      id: photo.id,
      recipient_id: photo.recipient_id,
      recipient_name: photo.profiles?.display_name || photo.profiles?.username || 'Unknown',
      recipient_avatar: photo.profiles?.avatar_url,
      total_images: photo.total_images_count || 0,
      paid_images_count: photo.paid_images_count || 0,
      unpaid_images_count: photo.unpaid_images_count || 0,
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

// Get received images for a user (images sent to them)
router.get('/received', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const { data: receivedPhotos, error, count } = await supabase
      .from('photos')
      .select(`
        id,
        sender_id,
        paid_images,
        unpaid_images,
        total_images_count,
        paid_images_count,
        unpaid_images_count,
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

    const formattedPhotos = receivedPhotos.map(photo => ({
      id: photo.id,
      sender_id: photo.sender_id,
      sender_name: photo.profiles?.display_name || photo.profiles?.username || 'Unknown',
      sender_avatar: photo.profiles?.avatar_url,
      total_images: photo.total_images_count || 0,
      paid_images_count: photo.paid_images_count || 0,
      unpaid_images_count: photo.unpaid_images_count || 0,
      is_payment_required: photo.is_payment_required,
      created_at: photo.created_at,
      updated_at: photo.updated_at,
      // Only show paid images URLs, keep unpaid images hidden
      paid_images: photo.paid_images || [],
      has_unpaid_images: (photo.unpaid_images_count || 0) > 0
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

module.exports = router;