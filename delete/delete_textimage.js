const express = require('express');
const router = express.Router();
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

// Rate limiting for chat image deletions
const chatImageDeleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit to 50 deletions per 15 minutes
  message: { error: 'Too many deletion requests, please try again later.' },
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

/**
 * Extract Cloudinary public ID from URL
 * @param {string} imageUrl - Full Cloudinary image URL
 * @returns {string|null} - Public ID or null if invalid
 */
const extractPublicId = (imageUrl) => {
  try {
    if (!imageUrl || typeof imageUrl !== 'string') {
      return null;
    }

    // Cloudinary URL format: https://res.cloudinary.com/{cloud_name}/image/upload/v{version}/{folder}/{public_id}.{format}
    const urlPattern = /\/v\d+\/(.+)\.\w+$/;
    const match = imageUrl.match(urlPattern);
    
    if (match && match[1]) {
      // Returns something like: chat_images/chat_userId_timestamp_random
      return match[1];
    }

    // Alternative pattern without version number
    const altPattern = /\/upload\/(.+)\.\w+$/;
    const altMatch = imageUrl.match(altPattern);
    
    if (altMatch && altMatch[1]) {
      return altMatch[1];
    }

    console.log(`Failed to extract public_id from URL: ${imageUrl}`);
    return null;
  } catch (error) {
    console.error('Error extracting public ID:', error);
    return null;
  }
};

/**
 * Delete a single image from Cloudinary
 * @param {string} publicId - Cloudinary public ID
 * @returns {Promise<boolean>} - Success status
 */
const deleteImageFromCloudinary = async (publicId) => {
  return new Promise((resolve) => {
    cloudinary.uploader.destroy(publicId, { invalidate: true }, (error, result) => {
      if (error) {
        console.error(`Failed to delete image ${publicId}:`, error);
        resolve(false);
      } else if (result.result === 'ok' || result.result === 'not found') {
        // 'not found' is acceptable - image might already be deleted
        console.log(`Image ${publicId} deleted successfully:`, result.result);
        resolve(true);
      } else {
        console.log(`Unexpected result deleting ${publicId}:`, result);
        resolve(false);
      }
    });
  });
};

/**
 * Verify message ownership
 * @param {string} messageId - Message UUID
 * @param {string} userId - User UUID
 * @returns {Promise<boolean>} - True if user owns the message
 */
const verifyMessageOwnership = async (messageId, userId) => {
  try {
    const { data: message, error } = await supabase
      .from('messages')
      .select('sender_id')
      .eq('id', messageId)
      .single();

    if (error || !message) {
      console.error('Message not found:', messageId);
      return false;
    }

    return message.sender_id === userId;
  } catch (error) {
    console.error('Error verifying message ownership:', error);
    return false;
  }
};

/**
 * @route   POST /api/images/delete-chat-images
 * @desc    Delete chat message images from Cloudinary
 * @access  Private (requires authentication and message ownership)
 * @body    { messageId: string, imageUrls: string[] }
 */
router.post('/delete-chat-images',
  chatImageDeleteLimiter,
  authenticateUser,
  async (req, res) => {
    try {
      const { messageId, imageUrls } = req.body;
      const userId = req.user.id;

      // Validate request
      if (!messageId || typeof messageId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid or missing messageId'
        });
      }

      if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or empty imageUrls array'
        });
      }

      console.log(`🗑️ Delete request for message ${messageId} by user ${userId}`);
      console.log(`📸 Images to delete: ${imageUrls.length}`);

      // Verify message ownership
      const ownsMessage = await verifyMessageOwnership(messageId, userId);
      if (!ownsMessage) {
        console.log(`❌ User ${userId} does not own message ${messageId}`);
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to delete this message'
        });
      }

      console.log(`✅ Message ownership verified`);

      // Extract public IDs from URLs
      const publicIds = imageUrls
        .map(url => extractPublicId(url))
        .filter(id => id !== null);

      if (publicIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid Cloudinary URLs provided'
        });
      }

      console.log(`📝 Extracted ${publicIds.length} valid public IDs`);

      // Delete images from Cloudinary in parallel with timeout
      const DELETION_TIMEOUT = 10000; // 10 seconds per image
      const deletionPromises = publicIds.map(publicId => 
        Promise.race([
          deleteImageFromCloudinary(publicId),
          new Promise(resolve => setTimeout(() => {
            console.log(`⏰ Deletion timeout for ${publicId}`);
            resolve(false);
          }, DELETION_TIMEOUT))
        ])
      );

      const results = await Promise.all(deletionPromises);

      // Calculate statistics
      const deletedCount = results.filter(success => success).length;
      const failedCount = results.length - deletedCount;

      // Create detailed results array
      const detailedResults = imageUrls.map((url, index) => ({
        url: url,
        deleted: publicIds[index] ? results[index] : false,
        reason: !publicIds[index] ? 'Invalid URL format' : 
                results[index] ? 'Success' : 'Cloudinary deletion failed'
      }));

      console.log(`✅ Deletion complete: ${deletedCount} succeeded, ${failedCount} failed`);

      // Determine overall success
      const overallSuccess = deletedCount > 0;
      const statusCode = failedCount === 0 ? 200 : (deletedCount > 0 ? 207 : 500);

      res.status(statusCode).json({
        success: overallSuccess,
        deletedCount: deletedCount,
        failedCount: failedCount,
        totalCount: imageUrls.length,
        results: detailedResults,
        message: failedCount === 0 
          ? `All ${deletedCount} image(s) deleted successfully`
          : `${deletedCount} image(s) deleted, ${failedCount} failed`
      });

    } catch (error) {
      console.error('❌ Chat image deletion error:', error);
      res.status(500).json({
        success: false,
        error: 'Server error during image deletion',
        details: error.message
      });
    }
  });

/**
 * @route   GET /api/images/delete-health
 * @desc    Health check for chat image deletion service
 * @access  Public
 */
router.get('/delete-health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Chat Image Deletion',
    timestamp: new Date().toISOString(),
    cloudinary_configured: !!process.env.CLOUDINARY_CLOUD_NAME
  });
});

// Error handling middleware specific to this router
router.use((error, req, res, next) => {
  console.error('Chat image deletion router error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error in image deletion service'
  });
});

module.exports = router;