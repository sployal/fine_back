const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const router = express.Router();

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

// Authentication middleware
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];
    
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

// Helper function to check if user is admin
const isUserAdmin = async (userId) => {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('user_type, is_admin')
      .eq('id', userId)
      .single();

    return profile && (profile.is_admin === true || profile.user_type === 'admin');
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
};

// Helper function to delete image from Cloudinary
const deleteFromCloudinary = async (imageUrl) => {
  try {
    if (!imageUrl || !imageUrl.includes('cloudinary.com')) {
      return { success: true, result: 'not_cloudinary' };
    }

    // Extract public_id from Cloudinary URL
    const urlParts = imageUrl.split('/');
    const uploadIndex = urlParts.indexOf('upload');
    
    if (uploadIndex === -1) {
      return { success: false, error: 'Invalid Cloudinary URL format' };
    }

    // Get public_id (skip version if present)
    let startIndex = uploadIndex + 1;
    if (urlParts[startIndex] && urlParts[startIndex].startsWith('v')) {
      startIndex++;
    }
    
    const publicIdParts = urlParts.slice(startIndex);
    let publicId = publicIdParts.join('/');
    publicId = publicId.replace(/\.[^/.]+$/, ''); // Remove file extension

    console.log(`Deleting from Cloudinary: ${publicId}`);

    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image'
    });

    if (result.result === 'ok') {
      return { success: true, result };
    } else if (result.result === 'not found') {
      return { success: true, result: 'not_found' };
    } else {
      return { success: false, error: `Cloudinary deletion failed: ${result.result}` };
    }
  } catch (error) {
    console.error('Cloudinary deletion error:', error);
    return { success: false, error: error.message };
  }
};

// DELETE /api/images/:imageId - Delete a single image
router.delete('/:imageId', authenticateUser, async (req, res) => {
  try {
    const { imageId } = req.params;
    const userId = req.user.id;

    console.log(`Delete request for image: ${imageId} by user: ${userId}`);

    // Get image data with photo collection info
    const { data: imageData, error: fetchError } = await supabase
      .from('images')
      .select(`
        id,
        image_url,
        photo_collection_id,
        photos!inner(sender_id, recipient_id)
      `)
      .eq('id', imageId)
      .single();

    if (fetchError || !imageData) {
      return res.status(404).json({
        success: false,
        error: 'Image not found'
      });
    }

    // Check if user is admin
    const isAdmin = await isUserAdmin(userId);

    // Check if user owns this image (is sender) or is the recipient
    const isSender = imageData.photos.sender_id === userId;
    const isRecipient = imageData.photos.recipient_id === userId;
    const canDelete = isSender || isRecipient;

    if (!canDelete && !isAdmin) {
      return res.status(403).json({ 
        success: false,
        error: 'You do not have permission to delete this image' 
      });
    }

    // Delete from Cloudinary first
    const cloudinaryResult = await deleteFromCloudinary(imageData.image_url);
    
    let cloudinarySuccess = cloudinaryResult.success;
    let cloudinaryError = null;

    if (!cloudinaryResult.success) {
      cloudinaryError = cloudinaryResult.error;
      console.warn(`Cloudinary deletion failed but continuing: ${cloudinaryError}`);
    }

    // Delete from database (RLS will handle permission check)
    const { error: dbError } = await supabase
      .from('images')
      .delete()
      .eq('id', imageId);

    if (dbError) {
      console.error('Database deletion error:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete image from database'
      });
    }

    console.log(`Image deleted successfully: ${imageId}`);

    res.json({
      success: true,
      message: 'Image deleted successfully',
      cloudinary_deleted: cloudinarySuccess,
      cloudinary_error: cloudinaryError
    });

  } catch (error) {
    console.error('Delete image error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error during image deletion'
    });
  }
});

// POST /api/images/bulk-delete - Delete multiple images
router.post('/bulk-delete', authenticateUser, async (req, res) => {
  try {
    const { imageIds } = req.body;
    const userId = req.user.id;

    if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No image IDs provided'
      });
    }

    console.log(`Bulk delete request for ${imageIds.length} images by user: ${userId}`);

    const isAdmin = await isUserAdmin(userId);
    const results = {
      totalCount: imageIds.length,
      successCount: 0,
      failedCount: 0,
      errors: [],
      cloudinaryErrors: []
    };

    // Get all images with photo collection info
    const { data: imagesData, error: fetchError } = await supabase
      .from('images')
      .select(`
        id,
        image_url,
        photo_collection_id,
        photos!inner(sender_id, recipient_id)
      `)
      .in('id', imageIds);

    if (fetchError) {
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch images'
      });
    }

    for (const imageId of imageIds) {
      try {
        const imageData = imagesData.find(img => img.id === imageId);

        if (!imageData) {
          results.failedCount++;
          results.errors.push(`${imageId}: Image not found`);
          continue;
        }

        // Check ownership - user can be either sender or recipient
        const isSender = imageData.photos.sender_id === userId;
        const isRecipient = imageData.photos.recipient_id === userId;
        const canDelete = isSender || isRecipient;

        if (!canDelete && !isAdmin) {
          results.failedCount++;
          results.errors.push(`${imageId}: Permission denied`);
          continue;
        }

        // Delete from Cloudinary
        const cloudinaryResult = await deleteFromCloudinary(imageData.image_url);
        
        if (!cloudinaryResult.success) {
          results.cloudinaryErrors.push(`${imageId}: ${cloudinaryResult.error}`);
        }

        // Delete from database
        const { error: dbError } = await supabase
          .from('images')
          .delete()
          .eq('id', imageId);

        if (dbError) {
          results.failedCount++;
          results.errors.push(`${imageId}: Database deletion failed`);
          continue;
        }

        results.successCount++;

      } catch (error) {
        results.failedCount++;
        results.errors.push(`${imageId}: ${error.message}`);
      }
    }

    console.log(`Bulk delete completed: ${results.successCount}/${results.totalCount} successful`);

    res.json({
      success: true,
      message: 'Bulk deletion completed',
      results: results
    });

  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error during bulk deletion'
    });
  }
});

// GET /api/images/:imageId/ownership - Check if user can delete image
router.get('/:imageId/ownership', authenticateUser, async (req, res) => {
  try {
    const { imageId } = req.params;
    const userId = req.user.id;

    const isAdmin = await isUserAdmin(userId);

    // Get image with photo collection info
    const { data: imageData } = await supabase
      .from('images')
      .select(`
        id,
        photos!inner(sender_id, recipient_id)
      `)
      .eq('id', imageId)
      .single();

    const isSender = imageData ? imageData.photos.sender_id === userId : false;
    const isRecipient = imageData ? imageData.photos.recipient_id === userId : false;
    const canDelete = isSender || isRecipient;

    res.json({
      success: true,
      can_delete: canDelete || isAdmin,
      is_admin: isAdmin,
      is_sender: isSender,
      is_recipient: isRecipient
    });

  } catch (error) {
    console.error('Check ownership error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error checking ownership'
    });
  }
});

module.exports = router;