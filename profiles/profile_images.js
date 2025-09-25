const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

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

// Rate limiting for profile uploads
const profileUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit profile uploads to 5 per 15 minutes
  message: { error: 'Too many profile image upload attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Configure multer for profile image uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit for profile images
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed for profile pictures!'), false);
    }
  },
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

// Helper function to upload profile images to Cloudinary
const uploadProfileImageToCloudinary = (buffer, userId) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'profiles', // Dedicated folder for profile images
        resource_type: 'image',
        transformation: [
          { quality: 'auto:good' },
          { fetch_format: 'auto' },
          { width: 400, height: 400, crop: 'fill', gravity: 'face' }, // Square crop focused on face
          { radius: 'max' } // Make it circular
        ],
        public_id: `profile_${userId}_${Date.now()}`,
        overwrite: true, // Allow overwriting previous profile images
        invalidate: true // Invalidate CDN cache
      },
      (error, result) => {
        if (error) {
          console.error('Cloudinary profile upload error:', error);
          reject(error);
        } else {
          console.log('Profile image uploaded successfully:', result.secure_url);
          resolve(result.secure_url);
        }
      }
    );
    
    uploadStream.end(buffer);
  });
};

// Helper function to delete old profile image from Cloudinary
const deleteOldProfileImage = async (imageUrl) => {
  try {
    if (!imageUrl) return { success: true };
    
    // Extract public_id from the URL
    const urlParts = imageUrl.split('/');
    const filename = urlParts[urlParts.length - 1];
    const publicId = `profiles/${filename.split('.')[0]}`;
    
    const result = await cloudinary.uploader.destroy(publicId);
    console.log('Old profile image deletion result:', result);
    
    // Return success status
    return { success: result.result === 'ok' || result.result === 'not found' };
  } catch (error) {
    console.error('Error deleting old profile image:', error);
    return { success: false, error: error.message };
  }
};

// Helper function to get current profile
const getCurrentProfile = async (userId) => {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('avatar_url')
    .eq('id', userId)
    .single();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
    throw new Error(`Failed to fetch current profile: ${error.message}`);
  }
  
  return profile;
};

// Routes

// Upload profile image endpoint - IMPROVED VERSION
router.post('/upload', profileUploadLimiter, authenticateUser, upload.single('profileImage'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No profile image provided' });
    }

    const userId = req.user.id;
    console.log(`📁 Uploading profile image for user: ${userId}`);
    console.log(`📊 Image size: ${(req.file.size / 1024 / 1024).toFixed(2)}MB`);
    console.log(`📷 Image type: ${req.file.mimetype}`);

    // STEP 1: Get current profile to check for existing avatar
    const currentProfile = await getCurrentProfile(userId);
    const currentAvatarUrl = currentProfile?.avatar_url;

    // STEP 2: Delete old profile image BEFORE uploading new one
    if (currentAvatarUrl) {
      console.log(`🗑️ Deleting existing profile image: ${currentAvatarUrl}`);
      const deletionResult = await deleteOldProfileImage(currentAvatarUrl);
      
      if (!deletionResult.success) {
        console.warn('⚠️ Failed to delete old profile image, but continuing with upload:', deletionResult.error);
        // Continue anyway - better to have a working new image than fail completely
      } else {
        console.log('✅ Old profile image deleted successfully');
      }
    }

    // STEP 3: Upload new profile image
    let newImageUrl;
    try {
      newImageUrl = await uploadProfileImageToCloudinary(req.file.buffer, userId);
      console.log(`✅ New profile image uploaded: ${newImageUrl}`);
    } catch (uploadError) {
      console.error('❌ Error uploading new profile image to Cloudinary:', uploadError);
      
      // If we deleted the old image but failed to upload new one, we should clean up the profile
      if (currentAvatarUrl) {
        await supabase
          .from('profiles')
          .upsert({
            id: userId,
            avatar_url: null,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'id'
          });
      }
      
      return res.status(500).json({ 
        error: 'Failed to upload profile image to cloud storage',
        details: uploadError.message 
      });
    }

    // STEP 4: Update the user's profile with the new avatar URL
    const { error: updateError } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        avatar_url: newImageUrl,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'id'
      });

    if (updateError) {
      console.error('❌ Error updating profile with new avatar URL:', updateError);
      
      // Clean up the newly uploaded image since we couldn't update the database
      await deleteOldProfileImage(newImageUrl);
      
      return res.status(500).json({ error: 'Failed to update profile with new avatar' });
    }

    console.log('✅ Profile updated with new avatar URL');

    res.json({
      success: true,
      avatarUrl: newImageUrl,
      message: 'Profile image uploaded successfully',
      replacedImage: !!currentAvatarUrl
    });

  } catch (error) {
    console.error('❌ Profile upload endpoint error:', error);
    res.status(500).json({ error: 'Server error during profile image upload' });
  }
});

// Get user profile image
router.get('/avatar/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('avatar_url, username, display_name')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json({
      success: true,
      avatarUrl: profile.avatar_url,
      username: profile.username,
      displayName: profile.display_name
    });

  } catch (error) {
    console.error('Get profile avatar error:', error);
    res.status(500).json({ error: 'Server error fetching profile avatar' });
  }
});

// Delete profile image endpoint
router.delete('/avatar', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get current profile
    const currentProfile = await getCurrentProfile(userId);

    if (!currentProfile?.avatar_url) {
      return res.status(400).json({ error: 'No profile image to delete' });
    }

    const currentAvatarUrl = currentProfile.avatar_url;

    // Delete from Cloudinary first
    const deletionResult = await deleteOldProfileImage(currentAvatarUrl);
    
    if (!deletionResult.success) {
      console.warn('⚠️ Failed to delete image from Cloudinary:', deletionResult.error);
      // Continue anyway to clean up database
    }

    // Update profile to remove avatar_url
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        avatar_url: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateError) {
      console.error('Error removing avatar URL from profile:', updateError);
      return res.status(500).json({ error: 'Failed to remove avatar from profile' });
    }

    console.log(`✅ Profile image deleted for user: ${userId}`);

    res.json({
      success: true,
      message: 'Profile image deleted successfully',
      cloudinaryDeleted: deletionResult.success
    });

  } catch (error) {
    console.error('Delete profile image error:', error);
    res.status(500).json({ error: 'Server error deleting profile image' });
  }
});

// Update profile endpoint (for username, display name, etc.)
router.put('/update', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { username, display_name, bio, user_type } = req.body;

    // Validate username if provided
    if (username) {
      if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: 'Username must be between 3 and 30 characters' });
      }

      // Check if username is already taken (excluding current user)
      const { data: existingUser } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', username)
        .neq('id', userId)
        .single();

      if (existingUser) {
        return res.status(400).json({ error: 'Username is already taken' });
      }
    }

    // Prepare update data
    const updateData = {
      updated_at: new Date().toISOString()
    };

    if (username !== undefined) updateData.username = username.trim();
    if (display_name !== undefined) updateData.display_name = display_name.trim();
    if (bio !== undefined) updateData.bio = bio.trim();
    if (user_type !== undefined) updateData.user_type = user_type;

    // Update profile
    const { data: updatedProfile, error: updateError } = await supabase
      .from('profiles')
      .update(updateData)
      .eq('id', userId)
      .select('id, username, display_name, avatar_url, bio, user_type, is_verified')
      .single();

    if (updateError) {
      console.error('Error updating profile:', updateError);
      return res.status(500).json({ error: 'Failed to update profile' });
    }

    console.log(`✅ Profile updated for user: ${userId}`);

    res.json({
      success: true,
      profile: updatedProfile,
      message: 'Profile updated successfully'
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error updating profile' });
  }
});

// Error handling middleware
router.use((error, req, res, next) => {
  console.error('Profile routes error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Profile image too large. Maximum size is 5MB.' });
    }
    return res.status(400).json({ error: 'Profile image upload error: ' + error.message });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = router;