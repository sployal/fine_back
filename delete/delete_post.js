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
      .select('user_type')
      .eq('id', userId)
      .single();

    return profile && profile.user_type === 'admin';
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

    console.log(`🗑️ Deleting from Cloudinary: ${publicId}`);

    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image'
    });

    if (result.result === 'ok') {
      console.log(`✅ Cloudinary deletion successful: ${publicId}`);
      return { success: true, result };
    } else if (result.result === 'not found') {
      console.log(`ℹ️ Image not found in Cloudinary: ${publicId}`);
      return { success: true, result: 'not_found' };
    } else {
      console.log(`⚠️ Cloudinary deletion failed: ${publicId} - ${result.result}`);
      return { success: false, error: `Cloudinary deletion failed: ${result.result}` };
    }
  } catch (error) {
    console.error('Cloudinary deletion error:', error);
    return { success: false, error: error.message };
  }
};

// Helper function to delete all images associated with a post from Cloudinary
const deletePostImagesFromCloudinary = async (images) => {
  const results = {
    total: images.length,
    successful: 0,
    failed: 0,
    errors: []
  };

  for (let i = 0; i < images.length; i++) {
    const imageUrl = images[i];
    console.log(`🖼️ Processing image ${i + 1}/${images.length}: ${imageUrl}`);

    const cloudinaryResult = await deleteFromCloudinary(imageUrl);
    
    if (cloudinaryResult.success) {
      results.successful++;
      if (cloudinaryResult.result !== 'not_cloudinary' && cloudinaryResult.result !== 'not_found') {
        console.log(`✅ Image ${i + 1} deleted from Cloudinary`);
      }
    } else {
      results.failed++;
      results.errors.push(`Image ${i + 1}: ${cloudinaryResult.error}`);
      console.error(`❌ Failed to delete image ${i + 1}: ${cloudinaryResult.error}`);
    }
  }

  return results;
};

// DELETE /api/posts/:postId - Delete a post with all its images and related data
router.delete('/:postId', authenticateUser, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    console.log(`🗑️ Delete request for post: ${postId} by user: ${userId}`);

    // Check if user is admin
    const isAdmin = await isUserAdmin(userId);
    console.log(`👤 User ${userId} is admin: ${isAdmin}`);

    // Get post data including images
    const { data: postData, error: fetchError } = await supabase
      .from('posts')
      .select('id, user_id, caption, images')
      .eq('id', postId)
      .single();

    if (fetchError || !postData) {
      console.log(`❌ Post not found: ${postId}`);
      return res.status(404).json({
        success: false,
        error: 'Post not found'
      });
    }

    console.log(`📝 Post found - Owner: ${postData.user_id}, Images: ${postData.images?.length || 0}`);

    // Check if user owns this post or is admin
    const isOwner = postData.user_id === userId;
    const canDelete = isOwner || isAdmin;

    if (!canDelete) {
      console.log(`🚫 Permission denied - User ${userId} cannot delete post owned by ${postData.user_id}`);
      return res.status(403).json({ 
        success: false,
        error: 'You do not have permission to delete this post' 
      });
    }

    console.log(`✅ User authorized to delete post (Owner: ${isOwner}, Admin: ${isAdmin})`);

    // Step 1: Count related records before deletion
    const [commentsResult, likesResult] = await Promise.all([
      supabase.from('comments').select('id', { count: 'exact' }).eq('post_id', postId),
      supabase.from('post_likes').select('id', { count: 'exact' }).eq('post_id', postId)
    ]);

    const commentsCount = commentsResult.count || 0;
    const likesCount = likesResult.count || 0;

    console.log(`📊 Related records - Comments: ${commentsCount}, Likes: ${likesCount}`);

    // Step 2: Delete images from Cloudinary
    let cloudinaryResults = { total: 0, successful: 0, failed: 0, errors: [] };
    
    if (postData.images && postData.images.length > 0) {
      console.log(`🖼️ Deleting ${postData.images.length} images from Cloudinary...`);
      cloudinaryResults = await deletePostImagesFromCloudinary(postData.images);
      
      console.log(`📈 Cloudinary deletion results: ${cloudinaryResults.successful}/${cloudinaryResults.total} successful`);
      if (cloudinaryResults.errors.length > 0) {
        console.log(`⚠️ Cloudinary errors:`, cloudinaryResults.errors);
      }
    }

    // Step 3: Delete related records from database (comments and likes)
    console.log(`🗄️ Deleting related database records...`);

    // Delete comment likes first (if any comments exist)
    if (commentsCount > 0) {
      const { error: commentLikesError } = await supabase
        .from('comment_likes')
        .delete()
        .in('comment_id', 
          supabase.from('comments').select('id').eq('post_id', postId)
        );

      if (commentLikesError) {
        console.error('Error deleting comment likes:', commentLikesError);
      } else {
        console.log('✅ Comment likes deleted');
      }
    }

    // Delete comments
    const { error: commentsError } = await supabase
      .from('comments')
      .delete()
      .eq('post_id', postId);

    if (commentsError) {
      console.error('Error deleting comments:', commentsError);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete post comments'
      });
    }

    console.log(`✅ Deleted ${commentsCount} comments`);

    // Delete post likes
    const { error: likesError } = await supabase
      .from('post_likes')
      .delete()
      .eq('post_id', postId);

    if (likesError) {
      console.error('Error deleting likes:', likesError);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete post likes'
      });
    }

    console.log(`✅ Deleted ${likesCount} likes`);

    // Step 4: Delete the post itself
    console.log(`🗑️ Deleting post from database...`);

    const { error: postDeleteError } = await supabase
      .from('posts')
      .delete()
      .eq('id', postId)
      // Add user check only if not admin (RLS policy should handle admin permissions)
      .eq(isAdmin ? 'id' : 'user_id', isAdmin ? postId : userId);

    if (postDeleteError) {
      console.error('Database post deletion error:', postDeleteError);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete post from database',
        details: postDeleteError.message
      });
    }

    // Step 5: Verify deletion
    console.log(`🔍 Verifying post deletion...`);
    
    // Small delay to ensure database consistency
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const { data: verifyPost } = await supabase
      .from('posts')
      .select('id')
      .eq('id', postId)
      .single();

    if (verifyPost) {
      console.error('❌ Post still exists after deletion attempt!');
      return res.status(500).json({
        success: false,
        error: 'Post deletion verification failed - post still exists'
      });
    }

    console.log(`✅ Post deletion verified - post ${postId} successfully removed`);

    // Prepare response
    const response = {
      success: true,
      message: 'Post deleted successfully',
      details: {
        post_id: postId,
        deleted_comments: commentsCount,
        deleted_likes: likesCount,
        cloudinary_results: cloudinaryResults,
        is_admin_delete: isAdmin && !isOwner
      }
    };

    // Add warnings if there were Cloudinary issues
    if (cloudinaryResults.failed > 0) {
      response.warnings = cloudinaryResults.errors;
    }

    res.json(response);

  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error during post deletion',
      details: error.message
    });
  }
});

// POST /api/posts/bulk-delete - Delete multiple posts
router.post('/bulk-delete', authenticateUser, async (req, res) => {
  try {
    const { postIds } = req.body;
    const userId = req.user.id;

    if (!postIds || !Array.isArray(postIds) || postIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No post IDs provided'
      });
    }

    console.log(`🗑️ Bulk delete request for ${postIds.length} posts by user: ${userId}`);

    const isAdmin = await isUserAdmin(userId);
    const results = {
      totalCount: postIds.length,
      successCount: 0,
      failedCount: 0,
      errors: [],
      cloudinaryResults: {
        totalImages: 0,
        deletedImages: 0,
        failedImages: 0
      }
    };

    // Get all posts with images
    const { data: postsData, error: fetchError } = await supabase
      .from('posts')
      .select('id, user_id, images')
      .in('id', postIds);

    if (fetchError) {
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch posts'
      });
    }

    for (const postId of postIds) {
      try {
        const postData = postsData.find(post => post.id === postId);

        if (!postData) {
          results.failedCount++;
          results.errors.push(`${postId}: Post not found`);
          continue;
        }

        // Check ownership
        const isOwner = postData.user_id === userId;
        const canDelete = isOwner || isAdmin;

        if (!canDelete) {
          results.failedCount++;
          results.errors.push(`${postId}: Permission denied`);
          continue;
        }

        // Delete images from Cloudinary
        if (postData.images && postData.images.length > 0) {
          const cloudinaryResult = await deletePostImagesFromCloudinary(postData.images);
          results.cloudinaryResults.totalImages += cloudinaryResult.total;
          results.cloudinaryResults.deletedImages += cloudinaryResult.successful;
          results.cloudinaryResults.failedImages += cloudinaryResult.failed;
        }

        // Delete related records and post
        await Promise.all([
          // Delete comment likes
          supabase.from('comment_likes').delete()
            .in('comment_id', 
              supabase.from('comments').select('id').eq('post_id', postId)
            ),
          // Delete comments
          supabase.from('comments').delete().eq('post_id', postId),
          // Delete likes
          supabase.from('post_likes').delete().eq('post_id', postId)
        ]);

        // Delete post
        const { error: deleteError } = await supabase
          .from('posts')
          .delete()
          .eq('id', postId)
          .eq(isAdmin ? 'id' : 'user_id', isAdmin ? postId : userId);

        if (deleteError) {
          results.failedCount++;
          results.errors.push(`${postId}: Database deletion failed`);
          continue;
        }

        results.successCount++;

      } catch (error) {
        results.failedCount++;
        results.errors.push(`${postId}: ${error.message}`);
      }
    }

    console.log(`📊 Bulk delete completed: ${results.successCount}/${results.totalCount} posts deleted`);
    console.log(`🖼️ Cloudinary: ${results.cloudinaryResults.deletedImages}/${results.cloudinaryResults.totalImages} images deleted`);

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

// GET /api/posts/:postId/can-delete - Check if user can delete a specific post
router.get('/:postId/can-delete', authenticateUser, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    const isAdmin = await isUserAdmin(userId);

    // Get post ownership info
    const { data: postData } = await supabase
      .from('posts')
      .select('id, user_id')
      .eq('id', postId)
      .single();

    const isOwner = postData ? postData.user_id === userId : false;
    const canDelete = isOwner || isAdmin;

    res.json({
      success: true,
      can_delete: canDelete,
      is_admin: isAdmin,
      is_owner: isOwner,
      post_exists: !!postData
    });

  } catch (error) {
    console.error('Check delete permission error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error checking delete permission'
    });
  }
});

// GET /api/posts/:postId/details - Get post details for deletion confirmation
router.get('/:postId/details', authenticateUser, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    // Get post with user info using the view or manual join
    const { data: postData, error } = await supabase
      .from('posts_with_users')
      .select(`
        id,
        user_id,
        caption,
        images,
        created_at,
        likes_count,
        comments_count,
        username,
        display_name
      `)
      .eq('id', postId)
      .single();

    if (error || !postData) {
      return res.status(404).json({
        success: false,
        error: 'Post not found'
      });
    }

    const isAdmin = await isUserAdmin(userId);
    const isOwner = postData.user_id === userId;
    const canDelete = isOwner || isAdmin;

    res.json({
      success: true,
      post: {
        id: postData.id,
        caption: postData.caption,
        imageCount: postData.images?.length || 0,
        likesCount: postData.likes_count || 0,
        commentsCount: postData.comments_count || 0,
        userName: postData.username || postData.display_name || 'Anonymous',
        createdAt: postData.created_at
      },
      permissions: {
        can_delete: canDelete,
        is_admin: isAdmin,
        is_owner: isOwner
      }
    });

  } catch (error) {
    console.error('Get post details error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error fetching post details'
    });
  }
});

module.exports = router;