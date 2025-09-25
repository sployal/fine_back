const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const router = express.Router();

// Initialize Supabase client (assuming same configuration as main server)
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

// Authentication middleware (same as main server)
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

// Helper function to extract public_id from Cloudinary URL
const extractPublicIdFromUrl = (imageUrl) => {
  try {
    if (!imageUrl || typeof imageUrl !== 'string') {
      return null;
    }

    // Handle Cloudinary URLs
    if (imageUrl.includes('cloudinary.com')) {
      // Extract the public_id from Cloudinary URL
      // Example: https://res.cloudinary.com/your-cloud/image/upload/v1234567890/folder/public_id.jpg
      const urlParts = imageUrl.split('/');
      const uploadIndex = urlParts.indexOf('upload');
      
      if (uploadIndex !== -1 && uploadIndex < urlParts.length - 1) {
        // Skip version if present (v1234567890)
        let startIndex = uploadIndex + 1;
        if (urlParts[startIndex] && urlParts[startIndex].startsWith('v') && /^\d+$/.test(urlParts[startIndex].substring(1))) {
          startIndex++;
        }
        
        // Get everything after upload (and version) as the public_id path
        const publicIdParts = urlParts.slice(startIndex);
        let publicId = publicIdParts.join('/');
        
        // Remove file extension
        publicId = publicId.replace(/\.[^/.]+$/, '');
        
        return publicId;
      }
    }

    return null;
  } catch (error) {
    console.error('Error extracting public_id from URL:', error);
    return null;
  }
};

// Helper function to delete image from Cloudinary
const deleteFromCloudinary = async (imageUrl) => {
  try {
    const publicId = extractPublicIdFromUrl(imageUrl);
    
    if (!publicId) {
      console.warn(`⚠️ Could not extract public_id from URL: ${imageUrl}`);
      return { success: false, error: 'Could not extract public_id from image URL' };
    }

    console.log(`🗑️ Deleting from Cloudinary: ${publicId}`);

    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image'
    });

    if (result.result === 'ok') {
      console.log(`✅ Successfully deleted from Cloudinary: ${publicId}`);
      return { success: true, result };
    } else if (result.result === 'not found') {
      console.log(`⚠️ Image not found in Cloudinary: ${publicId}`);
      return { success: true, result: 'not_found' };
    } else {
      console.error(`❌ Failed to delete from Cloudinary: ${publicId}`, result);
      return { success: false, error: `Cloudinary deletion failed: ${result.result}` };
    }
  } catch (error) {
    console.error('Cloudinary deletion error:', error);
    return { success: false, error: error.message };
  }
};

// Helper function to check image ownership
const checkImageOwnership = async (imageId, userId) => {
  try {
    // First check in sent_images table (assuming this is where sent images are stored)
    const { data: sentImage } = await supabase
      .from('sent_images')
      .select('sender_id, image_url')
      .eq('id', imageId)
      .single();

    if (sentImage && sentImage.sender_id === userId) {
      return { canDelete: true, imageData: sentImage };
    }

    // Also check in posts table in case it's a post image
    const { data: postImage } = await supabase
      .from('posts')
      .select('user_id, images')
      .contains('images', [imageId])
      .single();

    if (postImage && postImage.user_id === userId) {
      return { canDelete: true, imageData: { image_url: postImage.images.find(img => img.includes(imageId)) } };
    }

    return { canDelete: false, imageData: null };
  } catch (error) {
    console.error('Error checking image ownership:', error);
    return { canDelete: false, imageData: null };
  }
};

// DELETE /api/images/:imageId - Delete a single image
router.delete('/:imageId', authenticateUser, async (req, res) => {
  try {
    const { imageId } = req.params;
    const userId = req.user.id;

    console.log(`🗑️ Delete request for image: ${imageId} by user: ${userId}`);

    // Check if user is admin
    const isAdmin = await isUserAdmin(userId);

    // Check ownership or admin privileges
    const { canDelete, imageData } = await checkImageOwnership(imageId, userId);

    if (!canDelete && !isAdmin) {
      return res.status(403).json({ 
        success: false,
        error: 'You do not have permission to delete this image' 
      });
    }

    // Get image data if not already retrieved
    let imageUrl = imageData?.image_url;
    
    if (!imageUrl) {
      // Try to get from sent_images table
      const { data: sentImage } = await supabase
        .from('sent_images')
        .select('image_url')
        .eq('id', imageId)
        .single();

      imageUrl = sentImage?.image_url;
    }

    if (!imageUrl) {
      return res.status(404).json({
        success: false,
        error: 'Image not found'
      });
    }

    // Delete from Cloudinary first
    const cloudinaryResult = await deleteFromCloudinary(imageUrl);
    
    let cloudinarySuccess = cloudinaryResult.success;
    let cloudinaryError = null;

    if (!cloudinaryResult.success && cloudinaryResult.result !== 'not_found') {
      cloudinaryError = cloudinaryResult.error;
      console.warn(`⚠️ Cloudinary deletion failed but continuing with database deletion: ${cloudinaryError}`);
    }

    // Delete from database (sent_images table)
    const { error: dbError } = await supabase
      .from('sent_images')
      .delete()
      .eq('id', imageId);

    if (dbError) {
      console.error('Database deletion error:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete image from database'
      });
    }

    // Also try to remove from posts if it exists there
    try {
      const { data: postsWithImage } = await supabase
        .from('posts')
        .select('id, images')
        .contains('images', [imageUrl]);

      if (postsWithImage && postsWithImage.length > 0) {
        for (const post of postsWithImage) {
          const updatedImages = post.images.filter(img => img !== imageUrl);
          
          if (updatedImages.length === 0) {
            // If no images left, delete the post
            await supabase
              .from('posts')
              .delete()
              .eq('id', post.id);
          } else {
            // Update post with remaining images
            await supabase
              .from('posts')
              .update({ images: updatedImages })
              .eq('id', post.id);
          }
        }
      }
    } catch (postError) {
      console.warn('Error updating posts:', postError);
    }

    console.log(`✅ Image deleted successfully: ${imageId}`);

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

    console.log(`🗑️ Bulk delete request for ${imageIds.length} images by user: ${userId}`);

    const isAdmin = await isUserAdmin(userId);
    const results = {
      totalCount: imageIds.length,
      successCount: 0,
      failedCount: 0,
      errors: [],
      cloudinaryErrors: []
    };

    for (const imageId of imageIds) {
      try {
        // Check ownership
        const { canDelete, imageData } = await checkImageOwnership(imageId, userId);

        if (!canDelete && !isAdmin) {
          results.failedCount++;
          results.errors.push(`${imageId}: Permission denied`);
          continue;
        }

        // Get image URL
        let imageUrl = imageData?.image_url;
        
        if (!imageUrl) {
          const { data: sentImage } = await supabase
            .from('sent_images')
            .select('image_url')
            .eq('id', imageId)
            .single();

          imageUrl = sentImage?.image_url;
        }

        if (!imageUrl) {
          results.failedCount++;
          results.errors.push(`${imageId}: Image not found`);
          continue;
        }

        // Delete from Cloudinary
        const cloudinaryResult = await deleteFromCloudinary(imageUrl);
        
        if (!cloudinaryResult.success && cloudinaryResult.result !== 'not_found') {
          results.cloudinaryErrors.push(`${imageId}: ${cloudinaryResult.error}`);
        }

        // Delete from database
        const { error: dbError } = await supabase
          .from('sent_images')
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

    console.log(`✅ Bulk delete completed: ${results.successCount}/${results.totalCount} successful`);

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
    const { canDelete } = await checkImageOwnership(imageId, userId);

    res.json({
      success: true,
      can_delete: canDelete || isAdmin,
      is_admin: isAdmin,
      is_owner: canDelete
    });

  } catch (error) {
    console.error('Check ownership error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error checking ownership'
    });
  }
});

// DELETE /api/images/cleanup-orphaned - Admin only: cleanup orphaned Cloudinary images
router.delete('/cleanup-orphaned', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const isAdmin = await isUserAdmin(userId);

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Admin privileges required'
      });
    }

    console.log('🧹 Starting orphaned images cleanup...');

    // This is a more advanced feature - you might want to implement this based on your needs
    // It would involve:
    // 1. Getting all images from Cloudinary
    // 2. Checking which ones are not referenced in your database
    // 3. Deleting the orphaned ones

    res.json({
      success: true,
      message: 'Cleanup feature not yet implemented',
      note: 'This would require careful implementation to avoid deleting valid images'
    });

  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error during cleanup'
    });
  }
});

module.exports = router;