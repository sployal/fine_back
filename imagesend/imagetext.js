const express = require('express');
const router = express.Router();
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const rateLimit = require('express-rate-limit');

// Initialize Supabase client
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
    fileSize: 10 * 1024 * 1024, // 10MB limit per file
    files: 5, // Maximum 5 images per message
  },
  fileFilter: (req, file, cb) => {
    // Only allow image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
});

// Rate limiting for chat image uploads
const chatImageUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit to 20 uploads per 15 minutes (more lenient than posts)
  message: { error: 'Too many image uploads, please try again later.' },
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

// Helper function to upload chat images to Cloudinary
const uploadChatImageToCloudinary = (buffer, originalName, userId) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'chat_images', // Separate folder for chat images
        resource_type: 'image',
        transformation: [
          { quality: 'auto:good' },
          { fetch_format: 'auto' },
          { width: 1200, height: 1200, crop: 'limit' } // Limit size for chat images
        ],
        public_id: `chat_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
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

/**
 * @route   POST /api/images/upload-text
 * @desc    Upload images for chat messages
 * @access  Private (requires authentication)
 */
router.post('/upload-text', 
  chatImageUploadLimiter, 
  authenticateUser, 
  upload.array('images', 5), 
  async (req, res) => {
    try {
      // Validate that images were provided
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ 
          error: 'No images provided',
          success: false 
        });
      }

      const userId = req.user.id;
      console.log(`📸 Uploading ${req.files.length} chat image(s) for user: ${userId}`);

      const imageUrls = [];
      const uploadErrors = [];
      
      // Upload each image to Cloudinary
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        try {
          console.log(`⬆️ Uploading image ${i + 1}/${req.files.length}: ${file.originalname}`);
          
          const imageUrl = await uploadChatImageToCloudinary(
            file.buffer, 
            file.originalname,
            userId
          );
          
          imageUrls.push(imageUrl);
          console.log(`✅ Image ${i + 1} uploaded successfully: ${imageUrl}`);
          
        } catch (uploadError) {
          console.error(`❌ Error uploading image ${i + 1}:`, uploadError);
          uploadErrors.push({
            file: file.originalname,
            error: uploadError.message
          });
        }
      }

      // If no images were successfully uploaded, return error
      if (imageUrls.length === 0) {
        return res.status(500).json({ 
          error: 'Failed to upload any images',
          details: uploadErrors,
          success: false 
        });
      }

      // Return success response with uploaded image URLs
      const response = {
        success: true,
        imageUrls: imageUrls,
        message: `${imageUrls.length} image(s) uploaded successfully`,
        uploadedCount: imageUrls.length,
        totalCount: req.files.length
      };

      // Include errors if some uploads failed
      if (uploadErrors.length > 0) {
        response.partialSuccess = true;
        response.failedUploads = uploadErrors;
        response.message = `${imageUrls.length}/${req.files.length} images uploaded successfully`;
      }

      console.log(`✅ Chat image upload complete: ${imageUrls.length}/${req.files.length} successful`);
      
      res.status(200).json(response);

    } catch (error) {
      console.error('❌ Chat image upload endpoint error:', error);
      res.status(500).json({ 
        error: 'Server error during image upload',
        details: error.message,
        success: false 
      });
    }
});

/**
 * @route   GET /api/images/health
 * @desc    Health check for chat image upload service
 * @access  Public
 */
router.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    service: 'Chat Image Upload',
    timestamp: new Date().toISOString(),
    cloudinary_configured: !!process.env.CLOUDINARY_CLOUD_NAME
  });
});

// Error handling middleware specific to this router
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        error: 'File too large. Maximum size is 10MB per image.',
        success: false 
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ 
        error: 'Too many files. Maximum is 5 images per message.',
        success: false 
      });
    }
    return res.status(400).json({ 
      error: 'File upload error: ' + error.message,
      success: false 
    });
  }
  
  // Pass to general error handler
  next(error);
});

module.exports = router;