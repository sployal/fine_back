require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 5000;

// Environment variables validation
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required environment variables:');
  if (!SUPABASE_URL) console.error('- SUPABASE_URL is required');
  if (!SUPABASE_SERVICE_KEY) console.error('- SUPABASE_SERVICE_KEY is required');
  process.exit(1);
}

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error('Missing required Cloudinary environment variables');
  process.exit(1);
}

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Initialize Supabase with service role key - CRITICAL: Use service role for bypassing RLS
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Configure multer for memory storage
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
    }
});

// Basic middleware
app.use(helmet());
app.use(compression());
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('combined'));

// Debug middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl}`);
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  next();
});

// Helper function to upload image to Cloudinary
const uploadImageToCloudinary = (buffer) => {
    return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
            {
                resource_type: 'image',
                folder: 'photography_platform',
                public_id: `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                transformation: [
                    { width: 1080, height: 1080, crop: 'limit', quality: 85 }
                ]
            },
            (error, result) => {
                if (error) {
                    console.error('Cloudinary upload error:', error);
                    reject(error);
                } else {
                    resolve(result.secure_url);
                }
            }
        ).end(buffer);
    });
};

// Helper function to get user info from auth user
const getUserInfo = (authUser) => {
    if (!authUser) return null;
    
    const metadata = authUser.user_metadata || authUser.raw_user_meta_data || {};
    const fullName = metadata.full_name || metadata.name || authUser.email.split('@')[0];
    const firstName = fullName.split(' ')[0];
    
    let username;
    if (metadata.username && metadata.username !== authUser.email.split('@')[0]) {
        username = metadata.username;
    } else if (firstName && firstName !== authUser.email.split('@')[0]) {
        username = firstName;
    } else {
        username = authUser.email.split('@')[0];
    }
    
    return {
        id: authUser.id,
        email: authUser.email,
        fullName: fullName,
        username: username
    };
};

// Helper function to handle database errors
const handleDatabaseError = (error) => {
    console.error('Database error details:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
    });
    
    if (error.code === '23505') {
        return 'Duplicate entry';
    }
    if (error.code === '42703') {
        return 'Column does not exist: ' + error.message;
    }
    return error.message || 'Database operation failed';
};

// ROUTES

// Root route
app.get('/', (req, res) => {
    res.json({ 
        status: 'Photography Platform API is running',
        version: '2.0.0',
        timestamp: new Date().toISOString()
    });
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        // Test database connection
        const { data, error } = await supabase.from('posts').select('id').limit(1);
        
        res.status(200).json({ 
            status: 'OK',
            message: 'Photography Platform API is running',
            timestamp: new Date().toISOString(),
            database: error ? `Connection failed: ${error.message}` : 'Connected',
            supabase: {
                url: SUPABASE_URL ? 'Set' : 'Missing',
                serviceKey: SUPABASE_SERVICE_KEY ? 'Set' : 'Missing'
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            message: 'Health check failed',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Image upload endpoint
app.post('/api/upload-images', upload.array('images', 5), async (req, res) => {
    try {
        console.log('Upload request received');
        console.log('Files:', req.files ? req.files.length : 0);
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No images provided'
            });
        }

        const uploadPromises = req.files.map(file => 
            uploadImageToCloudinary(file.buffer)
        );

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

// Get posts with pagination
app.get('/api/posts', async (req, res) => {
    try {
        const { page = 1, limit = 10, user_id, tag } = req.query;
        const offset = (page - 1) * limit;
        
        console.log(`Fetching posts - page: ${page}, limit: ${limit}, user_id: ${user_id}, tag: ${tag}`);
        
        let query = supabase
            .from('posts')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (user_id) {
            query = query.eq('user_id', user_id);
        }
        
        const { data: posts, error, count } = await query
            .range(offset, offset + parseInt(limit) - 1);

        if (error) {
            console.error('Supabase posts fetch error:', error);
            return res.status(500).json({ 
                success: false, 
                error: handleDatabaseError(error)
            });
        }

        // Get user information for each post
        const userIds = [...new Set(posts.map(post => post.user_id))];
        const userPromises = userIds.map(async (userId) => {
            try {
                const { data: { user }, error } = await supabase.auth.admin.getUserById(userId);
                return { userId, user: error ? null : user };
            } catch (e) {
                console.warn(`Failed to get user ${userId}:`, e);
                return { userId, user: null };
            }
        });

        const userResults = await Promise.all(userPromises);
        const userMap = {};
        userResults.forEach(({ userId, user }) => {
            userMap[userId] = user ? getUserInfo(user) : {
                fullName: 'Anonymous',
                username: 'anonymous',
                email: 'unknown@example.com'
            };
        });

        // Get tags for posts
        const postIds = posts.map(post => post.id);
        const { data: postTags } = await supabase
            .from('post_tags')
            .select(`
                post_id,
                tags (name)
            `)
            .in('post_id', postIds);

        const tagsMap = {};
        if (postTags) {
            postTags.forEach(pt => {
                if (!tagsMap[pt.post_id]) {
                    tagsMap[pt.post_id] = [];
                }
                if (pt.tags && pt.tags.name) {
                    tagsMap[pt.post_id].push(pt.tags.name);
                }
            });
        }

        const transformedPosts = posts.map(post => {
            const userInfo = userMap[post.user_id];
            return {
                id: post.id,
                userId: post.user_id,
                userName: userInfo.username,
                imageUrl: post.image_url,
                caption: post.caption,
                location: post.location,
                tags: tagsMap[post.id] || [],
                createdAt: post.created_at,
                isVerified: false,
                userType: 'Photography Enthusiast',
                likes: post.likes || 0,
                commentCount: post.comment_count || 0,
                isFeatured: post.is_featured || false
            };
        });

        console.log(`Found ${transformedPosts.length} posts`);

        res.status(200).json({
            success: true,
            posts: transformedPosts,
            pagination: {
                total: count || transformedPosts.length,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil((count || transformedPosts.length) / limit)
            }
        });
    } catch (error) {
        console.error('Get posts error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch posts: ' + error.message
        });
    }
});

// Create new post - FIXED VERSION
app.post('/api/posts', async (req, res) => {
    try {
        const { content, tags = [], images = [], location, userId } = req.body;
        
        console.log('Creating post with data:', { content, tags, images, location, userId });
        
        // Enhanced validation
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

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

        // Validate userId format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(userId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid user ID format'
            });
        }

        // Test database connection before attempting insert
        console.log('Testing database connection...');
        const { data: testData, error: testError } = await supabase
            .from('posts')
            .select('id')
            .limit(1);

        if (testError) {
            console.error('Database connection test failed:', testError);
            return res.status(500).json({
                success: false,
                error: 'Database connection failed: ' + testError.message
            });
        }

        console.log('Database connection test successful');

        // Create the post with explicit column mapping
        const postData = {
            user_id: userId,
            image_url: images[0],
            caption: content.trim(), // Make sure we're using the caption column
            location: location || null,
            likes: 0,
            comment_count: 0,
            is_featured: false
        };

        console.log('Inserting post data:', postData);

        const { data: post, error: postError } = await supabase
            .from('posts')
            .insert([postData]) // Use array format for insert
            .select()
            .single();

        if (postError) {
            console.error('Post creation error:', postError);
            return res.status(500).json({
                success: false,
                error: handleDatabaseError(postError)
            });
        }

        console.log('Post created successfully:', post);

        // Handle tags if provided
        const processedTags = [];
        if (tags && tags.length > 0) {
            for (const tagName of tags) {
                if (tagName.trim()) {
                    try {
                        // Insert or get existing tag
                        let { data: tag, error: tagError } = await supabase
                            .from('tags')
                            .select('id')
                            .eq('name', tagName.toLowerCase().trim())
                            .single();

                        if (tagError && tagError.code === 'PGRST116') {
                            // Tag doesn't exist, create it
                            const { data: newTag, error: createTagError } = await supabase
                                .from('tags')
                                .insert([{ name: tagName.toLowerCase().trim() }])
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
                            const { error: linkError } = await supabase
                                .from('post_tags')
                                .insert([{
                                    post_id: post.id,
                                    tag_id: tag.id
                                }]);

                            if (!linkError) {
                                processedTags.push(tagName);
                            } else {
                                console.error('Tag linking error:', linkError);
                            }
                        }
                    } catch (tagProcessingError) {
                        console.error('Tag processing error:', tagProcessingError);
                        // Continue with other tags even if one fails
                    }
                }
            }
        }

        // Get user info for response
        let userInfo = { fullName: 'Anonymous', username: 'anonymous' };
        try {
            const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);
            if (!userError && user) {
                userInfo = getUserInfo(user);
            }
        } catch (userFetchError) {
            console.warn('Failed to fetch user info:', userFetchError);
        }

        // Format response to match Flutter app expectations
        const response = {
            success: true,
            post: {
                id: post.id,
                userId: post.user_id,
                userName: userInfo.username,
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

        console.log('Post creation response:', response);
        res.status(201).json(response);
    } catch (error) {
        console.error('Create post error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create post: ' + error.message
        });
    }
});

// Get single post
app.get('/api/posts/:id', async (req, res) => {
    try {
        const postId = req.params.id;
        
        const { data: post, error } = await supabase
            .from('posts')
            .select('*')
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

        // Get user info for this post
        let userInfo = { fullName: 'Anonymous', username: 'anonymous' };
        try {
            const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(post.user_id);
            if (!userError && user) {
                userInfo = getUserInfo(user);
            }
        } catch (e) {
            console.warn('Failed to get user info:', e);
        }

        // Get tags for this post
        const { data: postTags } = await supabase
            .from('post_tags')
            .select(`tags (name)`)
            .eq('post_id', postId);

        const tags = postTags?.map(pt => pt.tags?.name).filter(Boolean) || [];

        const transformedPost = {
            id: post.id,
            userId: post.user_id,
            userName: userInfo.username,
            imageUrl: post.image_url,
            caption: post.caption,
            location: post.location,
            tags: tags,
            createdAt: post.created_at,
            isVerified: false,
            userType: 'Photography Enthusiast',
            likes: post.likes || 0,
            commentCount: post.comment_count || 0,
            isFeatured: post.is_featured || false
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

// Like/unlike post
app.post('/api/posts/:id/like', async (req, res) => {
    try {
        const postId = req.params.id;
        const { userId } = req.body;

        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'User ID required'
            });
        }

        // Check if post exists
        const { data: post, error: postError } = await supabase
            .from('posts')
            .select('id, likes')
            .eq('id', postId)
            .single();

        if (postError) {
            return res.status(404).json({
                success: false,
                error: 'Post not found'
            });
        }

        // Check if already liked
        const { data: existingLike } = await supabase
            .from('likes')
            .select('id')
            .eq('post_id', postId)
            .eq('user_id', userId)
            .single();

        let liked = false;
        let message = '';
        let newLikeCount = post.likes || 0;

        if (existingLike) {
            // Unlike the post
            const { error: deleteError } = await supabase
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

            newLikeCount = Math.max(0, newLikeCount - 1);
            await supabase
                .from('posts')
                .update({ likes: newLikeCount })
                .eq('id', postId);

            liked = false;
            message = 'Post unliked';
        } else {
            // Like the post
            const { error: insertError } = await supabase
                .from('likes')
                .insert([{
                    post_id: postId,
                    user_id: userId
                }]);

            if (insertError) {
                return res.status(500).json({
                    success: false,
                    error: handleDatabaseError(insertError)
                });
            }

            newLikeCount = newLikeCount + 1;
            await supabase
                .from('posts')
                .update({ likes: newLikeCount })
                .eq('id', postId);

            liked = true;
            message = 'Post liked';
        }

        res.status(200).json({
            success: true,
            liked,
            likes: newLikeCount,
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
        const { data: tags, error } = await supabase
            .from('tags')
            .select('name')
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
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                success: false,
                error: 'File too large. Maximum size is 10MB.'
            });
        }
    }
    
    if (err.message === 'Only image files are allowed!') {
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
    console.log(`404 - Route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        requestedRoute: req.originalUrl
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Photography Platform API server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Health check available at http://localhost:${PORT}/api/health`);
});

module.exports = app;