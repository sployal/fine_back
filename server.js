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

// Initialize Supabase with service role key for admin operations
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

// Helper function to create user avatar initials
const createAvatarInitials = (fullName) => {
    if (!fullName) return 'U';
    return fullName.split(' ')
        .map(name => name[0])
        .join('')
        .toUpperCase()
        .substring(0, 2);
};

// Helper function to handle database errors
const handleDatabaseError = (error) => {
    console.error('Database error:', error);
    if (error.code === '23505') {
        return 'Duplicate entry';
    }
    return error.message || 'Database operation failed';
};

// ROUTES

// Root route
app.get('/', (req, res) => {
    res.json({ 
        status: 'Photography Platform API is running',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        environment: {
            nodeVersion: process.version,
            port: PORT,
            hasSupabaseUrl: !!SUPABASE_URL,
            hasSupabaseKey: !!SUPABASE_SERVICE_KEY,
            hasCloudinary: !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY)
        },
        availableRoutes: [
            'GET /api/health',
            'POST /api/upload-images',
            'GET /api/posts',
            'POST /api/posts',
            'GET /api/posts/:id',
            'PUT /api/posts/:id',
            'DELETE /api/posts/:id',
            'POST /api/posts/:id/like',
            'GET /api/tags',
            'GET /api/users/:userId'
        ]
    });
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        const { data, error } = await supabase.from('posts').select('count').limit(1);
        
        res.status(200).json({ 
            status: 'OK',
            message: 'Photography Platform API is running',
            timestamp: new Date().toISOString(),
            database: error ? 'Connection failed' : 'Connected'
        });
    } catch (error) {
        res.status(200).json({
            status: 'OK',
            message: 'Photography Platform API is running',
            timestamp: new Date().toISOString(),
            database: 'Connection not tested'
        });
    }
});

// Test route without /api prefix
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Server is running (no /api prefix)',
        timestamp: new Date().toISOString()
    });
});

// Get user by ID endpoint
app.get('/api/users/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const { data: { user }, error } = await supabase.auth.admin.getUserById(userId);
        
        if (error || !user) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        const userInfo = getUserInfo(user);
        
        res.json({ 
            success: true,
            user: userInfo 
        });
    } catch (error) {
        console.error('Get user by ID error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch user' 
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

// Get posts with pagination and user information
app.get('/api/posts', async (req, res) => {
    try {
        const { page = 1, limit = 10, user_id, tag } = req.query;
        const offset = (page - 1) * limit;
        
        console.log(`Fetching posts - page: ${page}, limit: ${limit}, user_id: ${user_id}, tag: ${tag}`);
        
        // Build query to get posts with user info from auth.users
        let query = supabase
            .from('posts')
            .select('*')
            .order('created_at', { ascending: false });
        
        // Apply filters
        if (user_id) {
            query = query.eq('user_id', user_id);
        }
        
        // Apply pagination
        const { data: posts, error, count } = await query
            .range(offset, offset + parseInt(limit) - 1);

        if (error) {
            console.error('Supabase posts fetch error:', error);
            return res.status(500).json({ 
                success: false, 
                error: 'Failed to fetch posts' 
            });
        }

        // Get user information for each post
        const userIds = [...new Set(posts.map(post => post.user_id))];
        const { data: { users }, error: usersError } = await supabase.auth.admin.listUsers();

        // Create user lookup map
        const userMap = {};
        if (users && !usersError) {
            users.forEach(user => {
                userMap[user.id] = getUserInfo(user);
            });
        }

        // Get tags for each post
        const postIds = posts.map(post => post.id);
        const { data: postTags } = await supabase
            .from('post_tags')
            .select(`
                post_id,
                tags (name)
            `)
            .in('post_id', postIds);

        // Create tags lookup map
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

        // Transform posts to match Flutter app expectations
        const transformedPosts = posts.map(post => {
            const userInfo = userMap[post.user_id] || {
                fullName: 'Anonymous',
                username: 'anonymous',
                email: 'unknown@example.com'
            };

            return {
                id: post.id,
                userId: post.user_id,
                userName: userInfo.username,
                imageUrl: post.image_url,
                caption: post.caption, // Using caption field from schema
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

// Create new post - MATCHES YOUR SCHEMA EXACTLY
app.post('/api/posts', async (req, res) => {
    try {
        const { content, tags = [], images = [], location, userId } = req.body;
        
        console.log('Creating post with data:', { content, tags, images, location, userId });
        
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

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'User ID is required'
            });
        }

        // Create the post - USING YOUR EXACT SCHEMA FIELDS
        const { data: post, error: postError } = await supabase
            .from('posts')
            .insert({
                user_id: userId,
                image_url: images[0], // Primary image
                caption: content, // USING CAPTION FIELD FROM YOUR SCHEMA
                location: location || null,
                likes: 0,
                comment_count: 0,
                is_featured: false
            })
            .select()
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
                    let { data: tag, error: tagError } = await supabase
                        .from('tags')
                        .select('id')
                        .eq('name', tagName.toLowerCase().trim())
                        .single();

                    if (tagError && tagError.code === 'PGRST116') {
                        // Tag doesn't exist, create it
                        const { data: newTag, error: createTagError } = await supabase
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
                        const { error: linkError } = await supabase
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

        // Get user info for response
        const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);
        let userInfo = { fullName: 'Anonymous', username: 'anonymous' };
        
        if (!userError && user) {
            userInfo = getUserInfo(user);
        }

        // Format response to match Flutter app expectations
        const response = {
            success: true,
            post: {
                id: post.id,
                userId: post.user_id,
                userName: userInfo.username,
                imageUrl: post.image_url,
                caption: post.caption, // USING CAPTION FROM DATABASE
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
        const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(post.user_id);
        let userInfo = { fullName: 'Anonymous', username: 'anonymous' };
        
        if (!userError && user) {
            userInfo = getUserInfo(user);
        }

        // Get tags for this post
        const { data: postTags } = await supabase
            .from('post_tags')
            .select(`
                tags (name)
            `)
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

// Update post
app.put('/api/posts/:id', async (req, res) => {
    try {
        const postId = req.params.id;
        const { content, location, tags, userId } = req.body;

        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'User ID required'
            });
        }

        // Check if user owns the post
        const { data: existingPost, error: fetchError } = await supabase
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
        if (content !== undefined) updates.caption = content; // USING CAPTION FIELD
        if (location !== undefined) updates.location = location;
        updates.updated_at = new Date().toISOString();

        const { data: post, error: updateError } = await supabase
            .from('posts')
            .update(updates)
            .eq('id', postId)
            .select()
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
            await supabase
                .from('post_tags')
                .delete()
                .eq('post_id', postId);

            // Add new tags
            const processedTags = [];
            for (const tagName of tags) {
                if (tagName.trim()) {
                    let { data: tag, error: tagError } = await supabase
                        .from('tags')
                        .select('id')
                        .eq('name', tagName.toLowerCase().trim())
                        .single();

                    if (tagError && tagError.code === 'PGRST116') {
                        const { data: newTag, error: createTagError } = await supabase
                            .from('tags')
                            .insert({ name: tagName.toLowerCase().trim() })
                            .select('id')
                            .single();

                        if (!createTagError) {
                            tag = newTag;
                        }
                    }

                    if (tag) {
                        const { error: linkError } = await supabase
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

        // Get user info
        const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(post.user_id);
        let userInfo = { username: 'anonymous' };
        
        if (!userError && user) {
            userInfo = getUserInfo(user);
        }

        const transformedPost = {
            id: post.id,
            userId: post.user_id,
            userName: userInfo.username,
            imageUrl: post.image_url,
            caption: post.caption,
            location: post.location,
            tags: tags !== undefined ? tags : [],
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
app.delete('/api/posts/:id', async (req, res) => {
    try {
        const postId = req.params.id;
        const { userId } = req.body;

        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'User ID required'
            });
        }

        // Check if user owns the post
        const { data: existingPost, error: fetchError } = await supabase
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
        const { error: deleteError } = await supabase
            .from('posts')
            .delete()
            .eq('id', postId);

        if (deleteError) {
            return res.status(500).json({
                success: false,
                error: handleDatabaseError(deleteError)
            });
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
        let newLikeCount = post.likes;

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

            // Update like count manually
            newLikeCount = Math.max(0, (post.likes || 0) - 1);
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

            // Update like count manually
            newLikeCount = (post.likes || 0) + 1;
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
    console.log(`API docs available at http://localhost:${PORT}/`);
});

module.exports = app;