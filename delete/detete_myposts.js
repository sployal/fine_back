const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const rateLimit = require('express-rate-limit');
require('dotenv').config();

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

// Rate limiting for delete operations
const deletePostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 delete requests per windowMs
  message: { error: 'Too many delete attempts, please try again later.' },
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

// Helper function to extract Cloudinary public ID from URL
const extractPublicIdFromUrl = (imageUrl) => {
  try {
    if (!imageUrl || typeof imageUrl !== 'string') {
      return null;
    }

    // Handle different Cloudinary URL formats
    // Standard format: https://res.cloudinary.com/cloud_name/image/upload/v1234567890/folder/public_id.jpg
    // Auto format: https://res.cloudinary.com/cloud_name/image/upload/folder/public_id.jpg
    
    const urlParts = imageUrl.split('/');
    const uploadIndex = urlParts.findIndex(part => part === 'upload');
    
    if (uploadIndex === -1) {
      console.log('Upload segment not found in URL:', imageUrl);
      return null;
    }

    // Get everything after 'upload' (skip version if present)
    let pathAfterUpload = urlParts.slice(uploadIndex + 1);
    
    // Remove version if it exists (starts with 'v' followed by numbers)
    if (pathAfterUpload.length > 0 && /^v\d+$/.test(pathAfterUpload[0])) {
      pathAfterUpload = pathAfterUpload.slice(1);
    }
    
    if (pathAfterUpload.length === 0) {
      return null;
    }

    // Join the remaining path and remove file extension
    let publicId = pathAfterUpload.join('/');
    
    // Remove file extension (everything after the last dot)
    const lastDotIndex = publicId.lastIndexOf('.');
    if (lastDotIndex > 0) {
      publicId = publicId.substring(0, lastDotIndex);
    }

    console.log(`Extracted public_id: "${publicId}" from URL: ${imageUrl}`);
    return publicId;
  } catch (error) {
    console.error('Error extracting public ID from URL:', imageUrl, error);
    return null;
  }
};

// Helper function to delete image from Cloudinary
const deleteFromCloudinary = async (imageUrl) => {
  try {
    const publicId = extractPublicIdFromUrl(imageUrl);
    
    if (!publicId) {
      console.log('Could not extract public ID from URL:', imageUrl);
      return { success: false, error: 'Invalid image URL format' };
    }

    console.log(`Attempting to delete image with public_id: ${publicId}`);
    
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image'
    });
    
    console.log('Cloudinary deletion result:', result);
    
    if (result.result === 'ok') {
      console.log(`Successfully deleted image: ${publicId}`);
      return { success: true };
    } else if (result.result === 'not found') {
      console.log(`Image not found in Cloudinary: ${publicId}`);
      return { success: true, warning: 'Image not found in cloud storage' };
    } else {
      console.log(`Failed to delete image: ${publicId}, result:`, result);
      return { success: false, error: result.result };
    }
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    return { success: false, error: error.message };
  }
};

// Delete post endpoint with Cloudinary cleanup
router.delete('/:postId', deletePostLimiter, authenticateUser, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    console.log(`🗑️ Delete request for post: ${postId} by user: ${userId}`);

    if (!postId || typeof postId !== 'string') {
      return res.status(400).json({ error: 'Invalid post ID' });
    }

    // First, fetch the post to ensure user owns it and get image URLs
    const { data: post, error: fetchError } = await supabase
      .from('posts')
      .select('id, user_id, images')
      .eq('id', postId)
      .single();

    if (fetchError || !post) {
      console.log('Post not found:', fetchError?.message);
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check if user owns the post or is admin
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('user_type')
      .eq('id', userId)
      .single();

    const isAdmin = userProfile?.user_type === 'admin';
    const isOwner = post.user_id === userId;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own posts' });
    }

    console.log(`✅ User authorized to delete post. Owner: ${isOwner}, Admin: ${isAdmin}`);

    // Delete images from Cloudinary first
    const images = post.images || [];
    const cloudinaryResults = [];
    
    console.log(`🖼️ Deleting ${images.length} image(s) from Cloudinary...`);

    for (const imageUrl of images) {
      if (imageUrl && typeof imageUrl === 'string') {
        const result = await deleteFromCloudinary(imageUrl);
        cloudinaryResults.push({
          url: imageUrl,
          ...result
        });
      }
    }

    // Log Cloudinary cleanup results
    const successfulDeletes = cloudinaryResults.filter(r => r.success).length;
    const failedDeletes = cloudinaryResults.filter(r => !r.success).length;
    
    console.log(`📊 Cloudinary cleanup: ${successfulDeletes} successful, ${failedDeletes} failed`);
    
    if (failedDeletes > 0) {
      const failedUrls = cloudinaryResults
        .filter(r => !r.success)
        .map(r => `${r.url}: ${r.error}`)
        .join(', ');
      console.log(`⚠️ Failed to delete images: ${failedUrls}`);
    }

    // Delete post from database (this will cascade delete likes and comments)
    const { error: deleteError } = await supabase
      .from('posts')
      .delete()
      .eq('id', postId);

    if (deleteError) {
      console.error('Database deletion error:', deleteError);
      return res.status(500).json({ 
        error: 'Failed to delete post from database',
        details: deleteError.message 
      });
    }

    console.log(`✅ Post ${postId} deleted successfully from database`);

    // Prepare response
    const response = {
      success: true,
      message: 'Post deleted successfully',
      postId: postId,
      cloudinaryCleanup: {
        totalImages: images.length,
        successful: successfulDeletes,
        failed: failedDeletes
      }
    };

    // Add warnings if some images couldn't be deleted from Cloudinary
    if (failedDeletes > 0) {
      response.warnings = cloudinaryResults
        .filter(r => !r.success)
        .map(r => `Could not delete image from cloud storage: ${r.error}`);
    }

    res.json(response);

  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ 
      error: 'Server error deleting post',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Bulk delete posts endpoint (for admin or user's own posts)
router.delete('/bulk/:userId', deletePostLimiter, authenticateUser, async (req, res) => {
  try {
    const { userId: targetUserId } = req.params;
    const currentUserId = req.user.id;

    console.log(`🗑️ Bulk delete request for user: ${targetUserId} by: ${currentUserId}`);

    // Check authorization
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('user_type')
      .eq('id', currentUserId)
      .single();

    const isAdmin = userProfile?.user_type === 'admin';
    const isOwner = targetUserId === currentUserId;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own posts' });
    }

    // Fetch all posts for the user
    const { data: posts, error: fetchError } = await supabase
      .from('posts')
      .select('id, images')
      .eq('user_id', targetUserId);

    if (fetchError) {
      console.error('Error fetching posts:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch posts' });
    }

    if (!posts || posts.length === 0) {
      return res.json({
        success: true,
        message: 'No posts found to delete',
        deletedPosts: 0,
        cloudinaryCleanup: { totalImages: 0, successful: 0, failed: 0 }
      });
    }

    console.log(`📝 Found ${posts.length} posts to delete`);

    // Delete images from Cloudinary
    let totalImages = 0;
    let successfulDeletes = 0;
    let failedDeletes = 0;

    for (const post of posts) {
      const images = post.images || [];
      totalImages += images.length;

      for (const imageUrl of images) {
        if (imageUrl && typeof imageUrl === 'string') {
          const result = await deleteFromCloudinary(imageUrl);
          if (result.success) {
            successfulDeletes++;
          } else {
            failedDeletes++;
          }
        }
      }
    }

    // Delete posts from database
    const { error: deleteError } = await supabase
      .from('posts')
      .delete()
      .eq('user_id', targetUserId);

    if (deleteError) {
      console.error('Database bulk deletion error:', deleteError);
      return res.status(500).json({ error: 'Failed to delete posts from database' });
    }

    console.log(`✅ Bulk deletion completed: ${posts.length} posts deleted`);

    res.json({
      success: true,
      message: `Successfully deleted ${posts.length} posts`,
      deletedPosts: posts.length,
      cloudinaryCleanup: {
        totalImages,
        successful: successfulDeletes,
        failed: failedDeletes
      }
    });

  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ 
      error: 'Server error during bulk deletion',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Health check for this module
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Delete posts module is healthy',
    cloudinaryConfig: {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME ? 'configured' : 'missing',
      apiKey: process.env.CLOUDINARY_API_KEY ? 'configured' : 'missing',
      apiSecret: process.env.CLOUDINARY_API_SECRET ? 'configured' : 'missing'
    }
  });
});

module.exports = router;