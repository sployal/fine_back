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

// TRUST PROXY CONFIGURATION - CRITICAL FOR RENDER DEPLOYMENT
app.set('trust proxy', 1); // Trust first proxy

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

// Rate limiting - Configured for proxy environment
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
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads (for posts)
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

// Helper function to upload POST images to Cloudinary
const uploadToCloudinary = (buffer, originalName) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'posts', // Keep posts in the posts folder
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

// Routes

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    proxy_trust: app.get('trust proxy')
  });
});

// Debug endpoint to check loaded routes
app.get('/api/debug/routes', (req, res) => {
  const routes = [];
  
  app._router.stack.forEach(middleware => {
    if (middleware.route) {
      routes.push({
        path: middleware.route.path,
        methods: Object.keys(middleware.route.methods)
      });
    } else if (middleware.name === 'router') {
      middleware.handle.stack.forEach(handler => {
        if (handler.route) {
          const basePath = middleware.regexp.source.replace('\\/?(?=\\/|$)', '').replace(/\\/g, '');
          routes.push({
            path: basePath + handler.route.path,
            methods: Object.keys(handler.route.methods)
          });
        }
      });
    }
  });

  res.json({
    success: true,
    routes: routes.filter(route => route.path.includes('mpesa')),
    allRoutes: routes
  });
});

// Try to import profile images routes
try {
  const profileImageRoutes = require('./profiles/profile_images');
  app.use('/api/profile', profileImageRoutes);
  console.log('✅ Profile images routes loaded successfully');
} catch (error) {
  console.error('⚠️ Failed to load profile images routes:', error.message);
  console.log('📝 Profile image functionality will be disabled');
}

// Load delete post routes BEFORE main server routes to prevent conflicts
try {
  const deletePostRoutes = require('./delete/delete_post');
  app.use('/api/posts', deletePostRoutes);
  console.log('✅ Delete post routes loaded successfully');
} catch (error) {
  console.error('⚠️ Failed to load delete post routes:', error.message);
  console.log('📝 Post deletion functionality will be disabled');
}

// Try to import image routes with error handling
try {
  const imageRoutes = require('./imagesend/image');
  app.use('/api/images', imageRoutes);
  console.log('✅ Image routes loaded successfully');
} catch (error) {
  console.error('⚠️ Failed to load image routes:', error.message);
  console.log('📝 Image sending functionality will be disabled');
}

// Import the M-Pesa payment routes (now contains all payment functionality)
try {
  const mpesaRoutes = require('./payment/mpesa');
  app.use('/api/payments', mpesaRoutes);
  console.log('✅ M-Pesa payment routes loaded successfully');
} catch (error) {
  console.error('⚠️ Failed to load M-Pesa payment routes:', error.message);
  console.log('📝 M-Pesa payment functionality will be disabled');
}

// Try to import delete routes with error handling
try {
  const deleteRoutes = require('./delete/delete_sent');
  app.use('/api/images', deleteRoutes);
  console.log('✅ Delete image routes loaded successfully');
} catch (error) {
  console.error('⚠️ Failed to load delete image routes:', error.message);
  console.log('📝 Image deletion functionality will be disabled');
}

// Load delete my posts routes AFTER existing delete routes
try {
  let deleteMyPostsRoutes;
  try {
    // Preferred correct filename
    deleteMyPostsRoutes = require('./delete/delete_myposts');
  } catch (innerError) {
    // Fallback to current filename with typo in repo
    deleteMyPostsRoutes = require('./delete/detete_myposts');
  }
  app.use('/api/posts', deleteMyPostsRoutes);
  console.log('✅ Delete my posts routes loaded successfully');
} catch (error) {
  console.error('⚠️ Failed to load delete my posts routes:', error.message);
  console.log('📝 Enhanced post deletion functionality will be disabled');
}

// Upload POST images endpoint (keeps using posts folder)
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

    // First, ensure user has a profile (create if missing)
    await ensureUserProfile(actualUserId);

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
      .select('id')
      .single();

    if (error) {
      console.error('Database error creating post:', error);
      return res.status(500).json({ error: 'Failed to create post in database' });
    }

    console.log(`✅ Post created successfully: ${post.id}`);

    // Now fetch the complete post data using the view
    const { data: completePost, error: fetchError } = await supabase
      .from('posts_with_users')
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
        username,
        display_name,
        avatar_url,
        is_verified,
        user_type
      `)
      .eq('id', post.id)
      .single();

    if (fetchError) {
      console.error('Error fetching complete post:', fetchError);
      // Fallback - still return success but with basic data
      return res.status(201).json({
        success: true,
        message: 'Post created successfully',
        post: {
          id: post.id,
          userId: actualUserId,
          userName: 'Anonymous',
          imageUrl: images[0],
          images: images,
          caption: content.trim(),
          location: location?.trim() || null,
          tags: tags || [],
          createdAt: new Date().toISOString(),
          isVerified: false,
          userType: 'Photography Enthusiast',
          likes: 0,
          commentCount: 0,
          isFeatured: false
        }
      });
    }

    // Format response using the complete data from the view - prioritize username
    const response = {
      success: true,
      message: 'Post created successfully',
      post: {
        id: completePost.id,
        userId: completePost.user_id,
        userName: completePost.username || completePost.display_name || 'Anonymous',
        imageUrl: completePost.images[0],
        images: completePost.images,
        caption: completePost.caption,
        location: completePost.location,
        tags: completePost.tags || [],
        createdAt: completePost.created_at,
        isVerified: completePost.is_verified || false,
        userType: completePost.user_type || 'Photography Enthusiast',
        likes: completePost.likes_count || 0,
        commentCount: completePost.comments_count || 0,
        isFeatured: completePost.is_featured || false
      }
    };

    res.status(201).json(response);

  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Server error creating post' });
  }
});

// Get posts endpoint - CORRECTED to prioritize username over display_name
app.get('/api/posts', async (req, res) => {
  try {
      const { page = 1, limit = 10 } = req.query;
      const offset = (page - 1) * limit;
      const userId = req.query.user_id;
      const tag = req.query.tag;
      
      console.log(`📥 Fetching posts - Page: ${page}, Limit: ${limit}, UserId: ${userId}, Tag: ${tag}`);
      
      // Try to use the posts_with_users view first
      try {
          let query = supabase
              .from('posts_with_users')
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
                  username,
                  display_name,
                  avatar_url,
                  is_verified,
                  user_type
              `)
              .order('created_at', { ascending: false });
          
          // Apply filters
          if (userId) {
              query = query.eq('user_id', userId);
          }
          if (tag) {
              query = query.contains('tags', [tag]);
          }
          
          const { data: posts, error } = await query
              .range(offset, offset + parseInt(limit) - 1);

          if (!error && posts) {
              console.log(`✅ Successfully fetched ${posts.length} posts using view`);
              
              // Transform posts for your Flutter app format - PRIORITIZE USERNAME
              const transformedPosts = posts.map(post => ({
                  id: post.id,
                  userId: post.user_id,
                  userName: post.username || post.display_name || 'Anonymous', // USERNAME FIRST
                  imageUrl: post.images?.[0] || '',
                  images: post.images || [],
                  caption: post.caption || '',
                  location: post.location,
                  tags: post.tags || [],
                  createdAt: post.created_at,
                  isVerified: post.is_verified || false,
                  userType: post.user_type || 'Photography Enthusiast',
                  likes: post.likes_count || 0,
                  commentCount: post.comments_count || 0,
                  isFeatured: post.is_featured || false
              }));

              return res.json({
                  success: true,
                  posts: transformedPosts,
                  pagination: {
                      page: parseInt(page),
                      limit: parseInt(limit),
                      total: posts.length,
                      hasMore: posts.length === parseInt(limit)
                  },
                  total: posts.length,
                  offset: offset
              });
          }
      } catch (viewError) {
          console.log('View not available, falling back to manual join');
      }
      
      // Manual approach using posts + profiles tables
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
              is_featured
          `, { count: 'exact' })
          .order('created_at', { ascending: false });
      
      // Apply filters
      if (userId) {
          query = query.eq('user_id', userId);
      }
      if (tag) {
          query = query.contains('tags', [tag]);
      }
      
      const { data: posts, error, count } = await query
          .range(offset, offset + parseInt(limit) - 1);

      if (error) {
          console.error('Supabase posts fetch error:', error);
          return res.status(500).json({ error: 'Failed to fetch posts' });
      }

      if (!posts || posts.length === 0) {
          console.log('📭 No posts found');
          return res.json({
              success: true,
              posts: [],
              pagination: {
                  page: parseInt(page),
                  limit: parseInt(limit),
                  total: count || 0,
                  hasMore: false
              },
              total: count || 0,
              offset: offset
          });
      }

      // Get user profiles from PROFILES table - PRIORITIZE USERNAME
      const userIds = [...new Set(posts.map(post => post.user_id))];
      const { data: userProfiles, error: profilesError } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url, is_verified, user_type')
          .in('id', userIds);

      if (profilesError) {
          console.error('Error fetching profiles:', profilesError);
      }

      console.log(`📊 Found ${userProfiles?.length || 0} profiles for ${userIds.length} unique users`);

      // Create user lookup map from profiles table - PRIORITIZE USERNAME
      const userMap = {};
      if (userProfiles && userProfiles.length > 0) {
          userProfiles.forEach(profile => {
              userMap[profile.id] = {
                  username: profile.username,
                  display_name: profile.display_name,
                  avatar_url: profile.avatar_url,
                  is_verified: profile.is_verified || false,
                  user_type: profile.user_type || 'Photography Enthusiast'
              };
          });
      }

      // For users without profiles, get username from auth.users
      const missingProfileUsers = userIds.filter(id => !userMap[id]);
      if (missingProfileUsers.length > 0) {
          console.log(`⚠️ Missing profiles for ${missingProfileUsers.length} users, fetching from auth.users`);
          
          for (const userId of missingProfileUsers) {
              try {
                  const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);
                  if (!userError && user) {
                      const username = extractUsernameFromAuth(user);
                      
                      userMap[userId] = {
                          username: username,
                          display_name: null,
                          avatar_url: null,
                          is_verified: false,
                          user_type: 'Photography Enthusiast'
                      };
                      console.log(`✅ Fetched username for user ${userId}: ${username}`);
                  }
              } catch (authError) {
                  console.error(`Failed to fetch auth user ${userId}:`, authError);
                  userMap[userId] = {
                      username: 'Anonymous',
                      display_name: null,
                      avatar_url: null,
                      is_verified: false,
                      user_type: 'Photography Enthusiast'
                  };
              }
          }
      }

      // Transform posts with user information for Flutter app - PRIORITIZE USERNAME
      const formattedPosts = posts.map(post => {
          const userInfo = userMap[post.user_id] || {
              username: 'Anonymous',
              display_name: null,
              avatar_url: null,
              is_verified: false,
              user_type: 'Photography Enthusiast'
          };

          // PRIORITIZE USERNAME OVER DISPLAY_NAME
          const userName = userInfo.username || userInfo.display_name || 'Anonymous';

          return {
              id: post.id,
              userId: post.user_id,
              userName: userName,
              imageUrl: post.images?.[0] || '',
              images: post.images || [],
              caption: post.caption || '',
              location: post.location,
              tags: post.tags || [],
              createdAt: post.created_at,
              isVerified: userInfo.is_verified,
              userType: userInfo.user_type,
              likes: post.likes_count || 0,
              commentCount: post.comments_count || 0,
              isFeatured: post.is_featured || false
          };
      });

      console.log(`✅ Returned ${formattedPosts.length} posts with profile data`);

      const response = {
          success: true,
          posts: formattedPosts,
          pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: count || 0,
              hasMore: (offset + parseInt(limit)) < (count || 0)
          },
          total: count || 0,
          offset: offset
      };

      res.json(response);

  } catch (error) {
      console.error('Get posts error:', error);
      res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// Helper function to extract username from auth user - CORRECTED
const extractUsernameFromAuth = (authUser) => {
  if (!authUser) return 'Anonymous';
  
  const metadata = authUser.user_metadata || authUser.raw_user_meta_data || {};
  
  // Try to get username first, then fallback to other fields
  let username = metadata.username || 
                metadata.preferred_username ||
                metadata.user_name;
  
  if (username && typeof username === 'string') {
      console.log(`👤 Found username: "${username}" for user: ${authUser.id}`);
      return username.trim();
  }
  
  // If no username, try display_name and extract first part
  let displayName = metadata.display_name || 
                   metadata.full_name || 
                   metadata.name;
                   
  if (displayName && typeof displayName === 'string') {
      const firstPart = displayName.trim().split(' ')[0];
      console.log(`👤 Extracted username from display_name: "${firstPart}" from "${displayName}" for user: ${authUser.id}`);
      return firstPart;
  }
  
  // Last fallback to email prefix
  const emailPrefix = authUser.email?.split('@')[0] || 'Anonymous';
  console.log(`👤 No username/display_name found, using email prefix: "${emailPrefix}" for user: ${authUser.id}`);
  
  return emailPrefix;
};

// Helper function to ensure user profile exists
async function ensureUserProfile(userId) {
  try {
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (existingProfile) {
      console.log(`✅ Profile exists for user: ${userId}`);
      return;
    }

    console.log(`📝 Creating missing profile for user: ${userId}`);

    const { data: authData } = await supabase.auth.admin.getUserById(userId);
    const user = authData?.user;
    
    if (!user) {
      console.log(`⚠️ Could not find auth user: ${userId}`);
      return;
    }

    const username = extractUsernameFromAuth(user);
    
    const { error: createError } = await supabase
      .from('profiles')
      .insert([{
        id: userId,
        username: username,
        display_name: username, // Set display_name same as username initially
        user_type: 'Photography Enthusiast',
        is_verified: false
      }]);

    if (createError) {
      console.error('Failed to create profile:', createError);
    } else {
      console.log(`✅ Created profile for user: ${userId} with username: ${username}`);
    }
  } catch (error) {
    console.error('Error in ensureUserProfile:', error);
  }
}

// Get single post endpoint
app.get('/api/posts/:postId', async (req, res) => {
  try {
    const { postId } = req.params;

    const { data: post, error } = await supabase
      .from('posts_with_users')
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
        username,
        display_name,
        avatar_url,
        is_verified,
        user_type
      `)
      .eq('id', postId)
      .single();

    if (error || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const formattedPost = {
      id: post.id,
      userId: post.user_id,
      userName: post.username || post.display_name || 'Anonymous', // USERNAME FIRST
      imageUrl: post.images?.[0] || '',
      images: post.images || [],
      caption: post.caption || '',
      location: post.location,
      tags: post.tags || [],
      createdAt: post.created_at,
      isVerified: post.is_verified || false,
      userType: post.user_type || 'Photography Enthusiast',
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

// Like/unlike post endpoint
app.post('/api/posts/:postId/like', authenticateUser, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user.id;

    console.log(`👍 Toggle like for post: ${postId} by user: ${userId}`);

    const { data: existingLike } = await supabase
      .from('post_likes')
      .select('id')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .single();

    let liked = false;
    let likesCount = 0;

    if (existingLike) {
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

    const { count } = await supabase
      .from('post_likes')
      .select('*', { count: 'exact', head: true })
      .eq('post_id', postId);

    likesCount = count || 0;

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
  console.log(`🛡️ Trust proxy enabled: ${app.get('trust proxy')}`);
});