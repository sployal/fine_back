require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 5000;

// Environment variables validation
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Service role key for admin operations
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Validate required environment variables
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
  console.error('Missing required environment variables:');
  if (!SUPABASE_URL) console.error('- SUPABASE_URL is required');
  if (!SUPABASE_SERVICE_KEY) console.error('- SUPABASE_SERVICE_KEY is required');
  if (!SUPABASE_ANON_KEY) console.error('- SUPABASE_ANON_KEY is required');
  process.exit(1);
}

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error('Missing required Cloudinary environment variables:');
  if (!process.env.CLOUDINARY_CLOUD_NAME) console.error('- CLOUDINARY_CLOUD_NAME is required');
  if (!process.env.CLOUDINARY_API_KEY) console.error('- CLOUDINARY_API_KEY is required');
  if (!process.env.CLOUDINARY_API_SECRET) console.error('- CLOUDINARY_API_SECRET is required');
  process.exit(1);
}

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Initialize Supabase clients
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 uploads per windowMs
  message: 'Too many uploads from this IP, please try again later.',
});

app.use(limiter);

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
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

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Access token required' 
    });
  }

  try {
    // Verify JWT token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid or expired token' 
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(403).json({ 
      success: false, 
      error: 'Token verification failed' 
    });
  }
};

// Utility function to upload image to Cloudinary
const uploadToCloudinary = async (buffer, originalName) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'photography_platform',
        public_id: `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        resource_type: 'auto',
        quality: 'auto:good',
        fetch_format: 'auto',
        flags: 'progressive',
        transformation: [
          { width: 1080, height: 1080, crop: 'limit', quality: 85 }
        ]
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

// Utility function to handle database errors
const handleDatabaseError = (error) => {
  console.error('Database error:', error);
  if (error.code === '23505') {
    return 'Duplicate entry';
  }
  return error.message || 'Database operation failed';
};

// ROUTES

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    message: 'Photography Platform API is running',
    timestamp: new Date().toISOString()
  });
});

// Upload images endpoint
app.post('/api/upload-images', uploadLimiter, authenticateToken, upload.array('images', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No images provided'
      });
    }

    console.log(`Uploading ${req.files.length} images for user ${req.user.id}`);

    const uploadPromises = req.files.map(async (file) => {
      try {
        const result = await uploadToCloudinary(file.buffer, file.originalname);
        return result.secure_url;
      } catch (error) {
        console.error('Individual upload error:', error);
        throw error;
      }
    });

    const imageUrls = await Promise.all(uploadPromises);

    console.log('Images uploaded successfully:', imageUrls);

    res.status(200).json({
      success: true,
      imageUrls,
      message: 'Images uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload images: ' + error.message
    });
  }
});

// Create a new post
app.post('/api/posts', authenticateToken, async (req, res) => {
  try {
    const { title, content, tags = [], images = [], location } = req.body;
    const userId = req.user.id;

    console.log('Creating post for user:', userId, { title, content, tags, images, location });

    // Validation
    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Post content is required'
      });
    }

    if (!images || images.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one image is required'
      });
    }

    // Create the post
    const { data: post, error: postError } = await supabaseAdmin
      .from('posts')
      .insert({
        user_id: userId,
        image_url: images[0], // Primary image
        caption: content,
        location: location || null,
        likes: 0,
        comment_count: 0,
        is_featured: false
      })
      .select(`
        *,
        auth.users!posts_user_id_fkey (
          id,
          email,
          raw_user_meta_data
        )
      `)
      .single();

    if (postError) {
      console.error('Post creation error:', postError);
      return res.status(500).json({
        success: false,
        error: handleDatabaseError(postError)
      });
    }

    // Handle tags if provided
    const processedTags = [];
    if (tags && tags.length > 0) {
      for (const tagName of tags) {
        if (tagName.trim()) {
          // Insert or get existing tag
          let { data: tag, error: tagError } = await supabaseAdmin
            .from('tags')
            .select('id')
            .eq('name', tagName.toLowerCase().trim())
            .single();

          if (tagError && tagError.code === 'PGRST116') {
            // Tag doesn't exist, create it
            const { data: newTag, error: createTagError } = await supabaseAdmin
              .from('tags')
              .insert({ name: tagName.toLowerCase().trim() })
              .select('id')
              .single();

            if (createTagError) {
              console.error('Tag creation error:', createTagError);
              continue;
            }
            tag = newTag;
          }

          if (tag) {
            // Link tag to post
            const { error: linkError } = await supabaseAdmin
              .from('post_tags')
              .insert({
                post_id: post.id,
                tag_id: tag.id
              });

            if (!linkError) {
              processedTags.push(tagName);
            }
          }
        }
      }
    }

    // Format response to match Flutter app expectations
    const response = {
      success: true,
      post: {
        id: post.id,
        userId: post.user_id,
        userName: post.users?.raw_user_meta_data?.name || post.users?.email?.split('@')[0] || 'User',
        imageUrl: post.image_url,
        caption: post.caption,
        location: post.location,
        tags: processedTags,
        createdAt: post.created_at,
        isVerified: false,
        userType: 'Photography Enthusiast',
        likes: post.likes,
        commentCount: post.comment_count,
        isFeatured: post.is_featured
      }
    };

    console.log('Post created successfully:', response);
    res.status(201).json(response);
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create post: ' + error.message
    });
  }
});

// Get posts with pagination
app.get('/api/posts', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const userId = req.query.user_id;
    const tag = req.query.tag;

    console.log(`Fetching posts - page: ${page}, limit: ${limit}, userId: ${userId}, tag: ${tag}`);

    let query = supabaseAdmin
      .from('posts')
      .select(`
        *,
        users:auth.users!posts_user_id_fkey (
          id,
          email,
          raw_user_meta_data
        ),
        post_tags (
          tags (
            name
          )
        )
      `)
      .order('created_at', { ascending: false });

    // Apply filters
    if (userId) {
      query = query.eq('user_id', userId);
    }

    if (tag) {
      query = query.contains('post_tags.tags.name', [tag]);
    }

    // Apply pagination
    query = query.range(offset, offset + limit - 1);

    const { data: posts, error: postsError, count } = await query;

    if (postsError) {
      console.error('Posts fetch error:', postsError);
      return res.status(500).json({
        success: false,
        error: handleDatabaseError(postsError)
      });
    }

    // Transform posts to match Flutter app expectations
    const transformedPosts = posts.map(post => {
      const postTags = post.post_tags?.map(pt => pt.tags?.name).filter(Boolean) || [];
      const user = post.users;
      
      return {
        id: post.id,
        userId: post.user_id,
        userName: user?.raw_user_meta_data?.name || user?.email?.split('@')[0] || 'User',
        imageUrl: post.image_url,
        caption: post.caption,
        location: post.location,
        tags: postTags,
        createdAt: post.created_at,
        isVerified: false, // You can add this field to your schema if needed
        userType: 'Photography Enthusiast', // You can add this field too
        likes: post.likes,
        commentCount: post.comment_count,
        isFeatured: post.is_featured
      };
    });

    console.log(`Found ${transformedPosts.length} posts`);

    res.status(200).json({
      success: true,
      posts: transformedPosts,
      pagination: {
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Fetch posts error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch posts: ' + error.message
    });
  }
});

// Get single post
app.get('/api/posts/:id', async (req, res) => {
  try {
    const postId = req.params.id;

    const { data: post, error } = await supabaseAdmin
      .from('posts')
      .select(`
        *,
        users:auth.users!posts_user_id_fkey (
          id,
          email,
          raw_user_meta_data
        ),
        post_tags (
          tags (
            name
          )
        )
      `)
      .eq('id', postId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Post not found'
        });
      }
      return res.status(500).json({
        success: false,
        error: handleDatabaseError(error)
      });
    }

    const postTags = post.post_tags?.map(pt => pt.tags?.name).filter(Boolean) || [];
    const user = post.users;

    const transformedPost = {
      id: post.id,
      userId: post.user_id,
      userName: user?.raw_user_meta_data?.name || user?.email?.split('@')[0] || 'User',
      imageUrl: post.image_url,
      caption: post.caption,
      location: post.location,
      tags: postTags,
      createdAt: post.created_at,
      isVerified: false,
      userType: 'Photography Enthusiast',
      likes: post.likes,
      commentCount: post.comment_count,
      isFeatured: post.is_featured
    };

    res.status(200).json({
      success: true,
      post: transformedPost
    });
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get post: ' + error.message
    });
  }
});

// Update post
app.put('/api/posts/:id', authenticateToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;
    const { content, location, tags } = req.body;

    // Check if user owns the post
    const { data: existingPost, error: fetchError } = await supabaseAdmin
      .from('posts')
      .select('user_id')
      .eq('id', postId)
      .single();

    if (fetchError) {
      return res.status(404).json({
        success: false,
        error: 'Post not found'
      });
    }

    if (existingPost.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized to update this post'
      });
    }

    // Update post
    const updates = {};
    if (content !== undefined) updates.caption = content;
    if (location !== undefined) updates.location = location;
    updates.updated_at = new Date().toISOString();

    const { data: post, error: updateError } = await supabaseAdmin
      .from('posts')
      .update(updates)
      .eq('id', postId)
      .select(`
        *,
        users:auth.users!posts_user_id_fkey (
          id,
          email,
          raw_user_meta_data
        ),
        post_tags (
          tags (
            name
          )
        )
      `)
      .single();

    if (updateError) {
      return res.status(500).json({
        success: false,
        error: handleDatabaseError(updateError)
      });
    }

    // Handle tag updates if provided
    if (tags !== undefined) {
      // Remove existing tags
      await supabaseAdmin
        .from('post_tags')
        .delete()
        .eq('post_id', postId);

      // Add new tags
      const processedTags = [];
      for (const tagName of tags) {
        if (tagName.trim()) {
          let { data: tag, error: tagError } = await supabaseAdmin
            .from('tags')
            .select('id')
            .eq('name', tagName.toLowerCase().trim())
            .single();

          if (tagError && tagError.code === 'PGRST116') {
            const { data: newTag, error: createTagError } = await supabaseAdmin
              .from('tags')
              .insert({ name: tagName.toLowerCase().trim() })
              .select('id')
              .single();

            if (!createTagError) {
              tag = newTag;
            }
          }

          if (tag) {
            const { error: linkError } = await supabaseAdmin
              .from('post_tags')
              .insert({
                post_id: postId,
                tag_id: tag.id
              });

            if (!linkError) {
              processedTags.push(tagName);
            }
          }
        }
      }
    }

    const postTags = post.post_tags?.map(pt => pt.tags?.name).filter(Boolean) || [];
    const user = post.users;

    const transformedPost = {
      id: post.id,
      userId: post.user_id,
      userName: user?.raw_user_meta_data?.name || user?.email?.split('@')[0] || 'User',
      imageUrl: post.image_url,
      caption: post.caption,
      location: post.location,
      tags: tags !== undefined ? tags : postTags,
      createdAt: post.created_at,
      isVerified: false,
      userType: 'Photography Enthusiast',
      likes: post.likes,
      commentCount: post.comment_count,
      isFeatured: post.is_featured
    };

    res.status(200).json({
      success: true,
      post: transformedPost
    });
  } catch (error) {
    console.error('Update post error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update post: ' + error.message
    });
  }
});

// Delete post
app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    // Check if user owns the post
    const { data: existingPost, error: fetchError } = await supabaseAdmin
      .from('posts')
      .select('user_id, image_url')
      .eq('id', postId)
      .single();

    if (fetchError) {
      return res.status(404).json({
        success: false,
        error: 'Post not found'
      });
    }

    if (existingPost.user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized to delete this post'
      });
    }

    // Delete from database (cascade will handle related records)
    const { error: deleteError } = await supabaseAdmin
      .from('posts')
      .delete()
      .eq('id', postId);

    if (deleteError) {
      return res.status(500).json({
        success: false,
        error: handleDatabaseError(deleteError)
      });
    }

    // Try to delete image from Cloudinary (optional, don't fail if it doesn't work)
    try {
      const imageUrl = existingPost.image_url;
      if (imageUrl && imageUrl.includes('cloudinary.com')) {
        const publicId = imageUrl.split('/').pop().split('.')[0];
        await cloudinary.uploader.destroy(`photography_platform/${publicId}`);
      }
    } catch (cloudinaryError) {
      console.warn('Failed to delete image from Cloudinary:', cloudinaryError);
    }

    res.status(200).json({
      success: true,
      message: 'Post deleted successfully'
    });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete post: ' + error.message
    });
  }
});

// Like/unlike post
app.post('/api/posts/:id/like', authenticateToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    // Check if post exists
    const { data: post, error: postError } = await supabaseAdmin
      .from('posts')
      .select('id')
      .eq('id', postId)
      .single();

    if (postError) {
      return res.status(404).json({
        success: false,
        error: 'Post not found'
      });
    }

    // Check if already liked
    const { data: existingLike, error: likeCheckError } = await supabaseAdmin
      .from('likes')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .single();

    let liked = false;
    let message = '';

    if (existingLike) {
      // Unlike the post
      const { error: deleteError } = await supabaseAdmin
        .from('likes')
        .delete()
        .eq('post_id', postId)
        .eq('user_id', userId);

      if (deleteError) {
        return res.status(500).json({
          success: false,
          error: handleDatabaseError(deleteError)
        });
      }

      liked = false;
      message = 'Post unliked';
    } else {
      // Like the post
      const { error: insertError } = await supabaseAdmin
        .from('likes')
        .insert({
          post_id: postId,
          user_id: userId
        });

      if (insertError) {
        return res.status(500).json({
          success: false,
          error: handleDatabaseError(insertError)
        });
      }

      liked = true;
      message = 'Post liked';
    }

    // Get updated like count
    const { data: updatedPost } = await supabaseAdmin
      .from('posts')
      .select('likes')
      .eq('id', postId)
      .single();

    res.status(200).json({
      success: true,
      liked,
      likes: updatedPost?.likes || 0,
      message
    });
  } catch (error) {
    console.error('Like post error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to like/unlike post: ' + error.message
    });
  }
});

// Get popular tags
app.get('/api/tags', async (req, res) => {
  try {
    const { data: tags, error } = await supabaseAdmin
      .from('tags')
      .select(`
        name,
        post_tags (count)
      `)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      return res.status(500).json({
        success: false,
        error: handleDatabaseError(error)
      });
    }

    res.status(200).json({
      success: true,
      tags: tags.map(tag => tag.name)
    });
  } catch (error) {
    console.error('Get tags error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get tags: ' + error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'File too large. Maximum size is 10MB.'
    });
  }

  if (error.message === 'Only image files are allowed!') {
    return res.status(400).json({
      success: false,
      error: 'Only image files are allowed!'
    });
  }

  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Photography Platform API server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/api/health`);
});

module.exports = app;