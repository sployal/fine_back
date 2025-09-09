const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables validation
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

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

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit uploads to 10 per 15 minutes
  message: { error: 'Too many upload attempts, please try again later.' },
});

app.use(limiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
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
const uploadToCloudinary = (buffer, originalName) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'posts',
        resource_type: 'image',
        transformation: [
          { quality: 'auto:good' },
          { fetch_format: 'auto' },
          { width: 1200, height: 1200, crop: 'limit' }
        ],
        public_id: `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
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

// Get user profile helper
const getUserProfile = async (userId) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('display_name, avatar_url, is_verified, user_type')
      .eq('id', userId)
      .single();

    if (error) {
      console.log('Profile fetch error:', error.message);
      return {
        display_name: 'Anonymous',
        avatar_url: null,
        is_verified: false,
        user_type: 'Photography Enthusiast'
      };
    }

    return {
      display_name: data.display_name || 'Anonymous',
      avatar_url: data.avatar_url,
      is_verified: data.is_verified || false,
      user_type: data.user_type || 'Photography Enthusiast'
    };
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return {
      display_name: 'Anonymous',
      avatar_url: null,
      is_verified: false,
      user_type: 'Photography Enthusiast'
    };
  }
};

// Routes

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Upload images endpoint
app.post('/api/upload-images', uploadLimiter, authenticateUser, upload.array('images', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }

    console.log(`📁 Uploading ${req.files.length} image(s) for user: ${req.user.id}`);

    const imageUrls = [];
    
    for (const file of req.files) {
      try {
        const imageUrl = await uploadToCloudinary(file.buffer, file.originalname);
        imageUrls.push(imageUrl);
        console.log(`✅ Image uploaded: ${imageUrl}`);
      } catch (error) {
        console.error('Error uploading image to Cloudinary:', error);
        return res.status(500).json({ error: 'Failed to upload image to cloud storage' });
      }
    }

    res.json({
      success: true,
      imageUrls: imageUrls,
      message: `${imageUrls.length} image(s) uploaded successfully`
    });

  } catch (error) {
    console.error('Upload endpoint error:', error);
    res.status(500).json({ error: 'Server error during image upload' });
  }
});

// Create post endpoint
app.post('/api/posts', authenticateUser, async (req, res) => {
  try {
    const { content, tags = [], images = [], location, userId } = req.body;

    // Validation
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Caption/content is required' });
    }

    if (content.trim().length > 2200) {
      return res.status(400).json({ error: 'Caption is too long (max 2200 characters)' });
    }

    if (!images || images.length === 0) {
      return res.status(400).json({ error: 'At least one image is required' });
    }

    // Ensure userId matches authenticated user
    const actualUserId = userId || req.user.id;
    if (actualUserId !== req.user.id) {
      return res.status(403).json({ error: 'Cannot create post for another user' });
    }

    console.log(`📝 Creating post for user: ${actualUserId}`);

    // Get user profile information
    const userProfile = await getUserProfile(actualUserId);

    // Insert post into database
    const { data: post, error } = await supabase
      .from('posts')
      .insert([{
        user_id: actualUserId,
        caption: content.trim(),
        location: location?.trim() || null,
        tags: Array.isArray(tags) ? tags.filter(tag => tag && tag.trim()) : [],
        images: Array.isArray(images) ? images : [images],
        created_at: new Date().toISOString()
      }])
      .select(`
        id,
        user_id,
        caption,
        location,
        tags,
        images,
        created_at,
        likes_count,
        comments_count,
        is_featured
      `)
      .single();

    if (error) {
      console.error('Database error creating post:', error);
      return res.status(500).json({ error: 'Failed to create post in database' });
    }

    console.log(`✅ Post created successfully: ${post.id}`);

    // Format response to match Flutter app expectations
    const response = {
      success: true,
      message: 'Post created successfully',
      post: {
        id: post.id,
        userId: post.user_id,
        userName: userProfile.display_name,
        imageUrl: post.images[0], // First image as primary
        images: post.images,
        caption: post.caption,
        location: post.location,
        tags: post.tags || [],
        createdAt: post.created_at,
        isVerified: userProfile.is_verified,
        userType: userProfile.user_type,
        likes: post.likes_count || 0,
        commentCount: post.comments_count || 0,
        isFeatured: post.is_featured || false
      }
    };

    res.status(201).json(response);

  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Server error creating post' });
  }
});

// Get posts endpoint with pagination
app.get('/api/posts', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Max 50 posts per request
    const offset = (page - 1) * limit;
    const userId = req.query.user_id;
    const tag = req.query.tag;

    console.log(`📥 Fetching posts - Page: ${page}, Limit: ${limit}, UserId: ${userId}, Tag: ${tag}`);

    let query = supabase
      .from('posts')
      .select(`
        id,
        user_id,
        caption,
        location,
        tags,
        images,
        created_at,
        likes_count,
        comments_count,
        is_featured,
        profiles:user_id (
          display_name,
          avatar_url,
          is_verified,
          user_type
        )
      `, { count: 'exact' });

    // Apply filters
    if (userId) {
      query = query.eq('user_id', userId);
    }

    if (tag) {
      query = query.contains('tags', [tag]);
    }

    // Apply pagination and ordering
    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: posts, error, count } = await query;

    if (error) {
      console.error('Database error fetching posts:', error);
      return res.status(500).json({ error: 'Failed to fetch posts' });
    }

    // Format posts for Flutter app
    const formattedPosts = posts.map(post => ({
      id: post.id,
      userId: post.user_id,
      userName: post.profiles?.display_name || 'Anonymous',
      imageUrl: post.images?.[0] || '',
      images: post.images || [],
      caption: post.caption || '',
      location: post.location,
      tags: post.tags || [],
      createdAt: post.created_at,
      isVerified: post.profiles?.is_verified || false,
      userType: post.profiles?.user_type || 'Photography Enthusiast',
      likes: post.likes_count || 0,
      commentCount: post.comments_count || 0,
      isFeatured: post.is_featured || false
    }));

    const response = {
      success: true,
      posts: formattedPosts,
      pagination: {
        page: page,
        limit: limit,
        total: count || 0,
        hasMore: (offset + limit) < (count || 0)
      },
      total: count || 0,
      offset: offset
    };

    console.log(`✅ Returned ${formattedPosts.length} posts`);
    res.json(response);

  } catch (error) {
    console.error('Fetch posts error:', error);
    res.status(500).json({ error: 'Server error fetching posts' });
  }
});

// Like/unlike post endpoint
app.post('/api/posts/:postId/like', authenticateUser, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    console.log(`👍 Toggle like for post: ${postId} by user: ${userId}`);

    // Check if user already liked the post
    const { data: existingLike } = await supabase
      .from('post_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .single();

    let liked = false;
    let likesCount = 0;

    if (existingLike) {
      // Unlike: Remove the like
      const { error: unlikeError } = await supabase
        .from('post_likes')
        .delete()
        .eq('post_id', postId)
        .eq('user_id', userId);

      if (unlikeError) {
        console.error('Error removing like:', unlikeError);
        return res.status(500).json({ error: 'Failed to unlike post' });
      }

      liked = false;
    } else {
      // Like: Add the like
      const { error: likeError } = await supabase
        .from('post_likes')
        .insert([{
          post_id: postId,
          user_id: userId,
          created_at: new Date().toISOString()
        }]);

      if (likeError) {
        console.error('Error adding like:', likeError);
        return res.status(500).json({ error: 'Failed to like post' });
      }

      liked = true;
    }

    // Get updated likes count
    const { count } = await supabase
      .from('post_likes')
      .select('*', { count: 'exact', head: true })
      .eq('post_id', postId);

    likesCount = count || 0;

    // Update likes count in posts table
    await supabase
      .from('posts')
      .update({ likes_count: likesCount })
      .eq('id', postId);

    console.log(`✅ Like toggled - Liked: ${liked}, Total likes: ${likesCount}`);

    res.json({
      success: true,
      liked: liked,
      likes: likesCount,
      message: liked ? 'Post liked' : 'Post unliked'
    });

  } catch (error) {
    console.error('Toggle like error:', error);
    res.status(500).json({ error: 'Server error toggling like' });
  }
});

// Get single post endpoint
app.get('/api/posts/:postId', async (req, res) => {
  try {
    const { postId } = req.params;

    const { data: post, error } = await supabase
      .from('posts')
      .select(`
        id,
        user_id,
        caption,
        location,
        tags,
        images,
        created_at,
        likes_count,
        comments_count,
        is_featured,
        profiles:user_id (
          display_name,
          avatar_url,
          is_verified,
          user_type
        )
      `)
      .eq('id', postId)
      .single();

    if (error || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const formattedPost = {
      id: post.id,
      userId: post.user_id,
      userName: post.profiles?.display_name || 'Anonymous',
      imageUrl: post.images?.[0] || '',
      images: post.images || [],
      caption: post.caption || '',
      location: post.location,
      tags: post.tags || [],
      createdAt: post.created_at,
      isVerified: post.profiles?.is_verified || false,
      userType: post.profiles?.user_type || 'Photography Enthusiast',
      likes: post.likes_count || 0,
      commentCount: post.comments_count || 0,
      isFeatured: post.is_featured || false
    };

    res.json({
      success: true,
      post: formattedPost
    });

  } catch (error) {
    console.error('Get single post error:', error);
    res.status(500).json({ error: 'Server error fetching post' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    return res.status(400).json({ error: 'File upload error: ' + error.message });
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}`);
});