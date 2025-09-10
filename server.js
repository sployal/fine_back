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

// Alternative authentication approach if the main one fails
const authenticateUserAlternative = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];
    
    // Try direct JWT verification first
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.decode(token, { complete: true });
      
      if (!decoded) {
        throw new Error('Invalid JWT format');
      }
      
      console.log('🔐 JWT payload:', decoded.payload);
      
      // Then verify with Supabase
      const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': process.env.SUPABASE_SERVICE_KEY
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.log('❌ Supabase API error:', response.status, errorText);
        throw new Error(`Supabase API error: ${response.status}`);
      }
      
      const userData = await response.json();
      console.log('✅ User data from Supabase:', userData.id, userData.email);
      
      req.user = userData;
      next();
      
    } catch (jwtError) {
      console.log('❌ JWT or API error:', jwtError.message);
      return res.status(401).json({ error: 'Invalid token format or expired' });
    }
    
  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};
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
// Create post endpoint - IMPROVED VERSION
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

    // Format response using the complete data from the view
    const response = {
      success: true,
      message: 'Post created successfully',
      post: {
        id: completePost.id,
        userId: completePost.user_id,
        userName: completePost.display_name || 'Anonymous',
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

// Add this GET /api/posts endpoint to your server (it's completely missing!)
// Get posts with user information - FIXED to use user_profiles table
app.get('/api/posts', async (req, res) => {
  try {
      const { page = 1, limit = 10 } = req.query;
      const offset = (page - 1) * limit;
      const userId = req.query.user_id;
      const tag = req.query.tag;
      
      console.log(`📥 Fetching posts - Page: ${page}, Limit: ${limit}, UserId: ${userId}, Tag: ${tag}`);
      
      // OPTION 1: Try to use the posts_with_users view first (if it references user_profiles)
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
              
              // Transform posts for your Flutter app format
              const transformedPosts = posts.map(post => ({
                  id: post.id,
                  userId: post.user_id,
                  userName: post.username || post.display_name || 'Anonymous',
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
      
      // OPTION 2: Manual approach using posts + user_profiles tables
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

      // Get user profiles from user_profiles table (NOT profiles table)
      const userIds = [...new Set(posts.map(post => post.user_id))];
      const { data: userProfiles, error: profilesError } = await supabase
          .from('user_profiles')
          .select('id, username, display_name, avatar_url, is_verified, user_type')
          .in('id', userIds);

      console.log(`📊 Found ${userProfiles?.length || 0} user profiles for ${userIds.length} unique users`);

      // Create user lookup map from user_profiles
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

      // For users without user_profiles, get display_name from auth.users
      const missingProfileUsers = userIds.filter(id => !userMap[id]);
      if (missingProfileUsers.length > 0) {
          console.log(`⚠️ Missing user_profiles for ${missingProfileUsers.length} users, fetching from auth.users`);
          
          for (const userId of missingProfileUsers) {
              try {
                  const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);
                  if (!userError && user) {
                      // Extract first name from display_name or fallback to email prefix
                      const displayName = extractFirstNameFromDisplayName(user);
                      
                      userMap[userId] = {
                          username: null, // No username in user_profiles
                          display_name: displayName,
                          avatar_url: null,
                          is_verified: false,
                          user_type: 'Photography Enthusiast'
                      };
                      console.log(`✅ Fetched display name for user ${userId}: ${displayName}`);
                  }
              } catch (authError) {
                  console.error(`Failed to fetch auth user ${userId}:`, authError);
                  userMap[userId] = {
                      username: null,
                      display_name: 'Anonymous',
                      avatar_url: null,
                      is_verified: false,
                      user_type: 'Photography Enthusiast'
                  };
              }
          }
      }

      // Transform posts with user information for Flutter app
      const formattedPosts = posts.map(post => {
          const userInfo = userMap[post.user_id] || {
              username: null,
              display_name: 'Anonymous',
              avatar_url: null,
              is_verified: false,
              user_type: 'Photography Enthusiast'
          };

          // Priority: username from user_profiles > display_name from auth.users > Anonymous
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

      console.log(`✅ Returned ${formattedPosts.length} posts with user profile data`);

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

// Helper function to extract first name from display_name in auth.users
const extractFirstNameFromDisplayName = (authUser) => {
  if (!authUser) return 'Anonymous';
  
  // Try to get display_name from user metadata or raw_user_meta_data
  const metadata = authUser.user_metadata || authUser.raw_user_meta_data || {};
  
  let displayName = metadata.display_name || 
                   metadata.full_name || 
                   metadata.name;
  
  // If we have a display_name, extract the first name
  if (displayName && typeof displayName === 'string') {
      const firstName = displayName.trim().split(' ')[0];
      console.log(`👤 Extracted first name: "${firstName}" from display_name: "${displayName}" for user: ${authUser.id}`);
      return firstName;
  }
  
  // Fallback to email prefix if no display_name
  const emailPrefix = authUser.email?.split('@')[0] || 'Anonymous';
  console.log(`👤 No display_name found, using email prefix: "${emailPrefix}" for user: ${authUser.id}`);
  
  return emailPrefix;
};

///end of fech user profile



// Helper function to ensure user profile exists
async function ensureUserProfile(userId) {
  try {
    // Check if profile exists
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

    // Get user info from auth
    const { data: authData } = await supabase.auth.admin.getUserById(userId);
    const user = authData?.user;
    
    if (!user) {
      console.log(`⚠️ Could not find auth user: ${userId}`);
      return;
    }

    // Create profile
    const displayName = user.email?.split('@')[0] || 'Anonymous';
    
    const { error: createError } = await supabase
      .from('profiles')
      .insert([{
        id: userId,
        display_name: displayName,
        user_type: 'Photography Enthusiast',
        is_verified: false
      }]);

    if (createError) {
      console.error('Failed to create profile:', createError);
    } else {
      console.log(`✅ Created profile for user: ${userId} with name: ${displayName}`);
    }
  } catch (error) {
    console.error('Error in ensureUserProfile:', error);
  }
}


// Also update the single post endpoint
app.get('/api/posts/:postId', async (req, res) => {
  try {
    const { postId } = req.params;

    const { data: post, error } = await supabase
      .from('posts_with_users')  // ← Use the view here too
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
      userName: post.display_name || 'Anonymous',
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