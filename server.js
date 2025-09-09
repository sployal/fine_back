const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize Supabase with service role key for admin operations
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
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
app.use(cors({
    origin: '*',
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('combined'));

// Helper function to upload image to Cloudinary
const uploadImageToCloudinary = (buffer) => {
    return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
            {
                resource_type: 'image',
                folder: 'flodaz_community',
                transformation: [
                    { width: 800, height: 600, crop: 'limit' },
                    { quality: 'auto:good' }
                ]
            },
            (error, result) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(result.secure_url);
                }
            }
        ).end(buffer);
    });
};

// CORRECTED: Helper function to get user info with proper priority system
const getUserInfo = (authUser) => {
    if (!authUser) return null;
    
    // FIXED: Use user_metadata instead of raw_user_meta_data
    const metadata = authUser.user_metadata || {};
    
    // Get full name
    const fullName = metadata.full_name || metadata.name || authUser.email.split('@')[0];
    
    // Extract first name for fallback
    const firstName = fullName.split(' ')[0];
    
    // Priority: username > firstName > email prefix
    let username;
    if (metadata.username && metadata.username !== authUser.email.split('@')[0]) {
        username = metadata.username;  // This will now find 'Davie'
    } else if (firstName && firstName !== authUser.email.split('@')[0]) {
        username = firstName;  // This will find 'David'
    } else {
        username = authUser.email.split('@')[0];  // Final fallback
    }
    
    return {
        id: authUser.id,
        email: authUser.email,
        fullName: fullName,
        username: username,
        accountType: metadata.account_type || 'free'
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

// Routes
app.get('/', (req, res) => {
    res.json({ 
        message: 'Welcome to Flodaz Community API',
        version: '2.0.0',
        status: 'running',
        endpoints: {
            health: 'GET /api/health',
            posts: 'GET /api/posts',
            createPost: 'POST /api/posts',
            getPost: 'GET /api/posts/:id',
            getUserById: 'GET /api/users/:userId',
            uploadImages: 'POST /api/upload-images',
            likePost: 'POST /api/posts/:id/like',
            getComments: 'GET /api/comments/:postId',
            createComment: 'POST /api/comments'
        }
    });
});

app.get('/api/health', async (req, res) => {
    try {
        // Test Supabase connection
        const { data, error } = await supabase.from('posts').select('count').limit(1);
        
        res.json({ 
            status: 'OK', 
            timestamp: new Date().toISOString(),
            message: 'Server is running successfully!',
            database: error ? 'Connection failed' : 'Connected'
        });
    } catch (error) {
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            message: 'Server running, database connection not tested',
            database: 'Unknown'
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
        
        // Build query with user info and tags
        let query = supabase
            .from('posts')
            .select(`
                *,
                post_tags (
                    tags (
                        name
                    )
                )
            `)
            .order('created_at', { ascending: false });
        
        // Apply filters
        if (user_id) {
            query = query.eq('user_id', user_id);
        }
        
        if (tag) {
            query = query.contains('post_tags.tags.name', [tag]);
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

        // Transform posts to match Flutter app expectations
        const transformedPosts = posts.map(post => {
            const userInfo = userMap[post.user_id] || {
                fullName: 'Anonymous',
                username: 'anonymous',
                email: 'unknown@example.com'
            };

            const postTags = post.post_tags?.map(pt => pt.tags?.name).filter(Boolean) || [];

            return {
                id: post.id,
                userId: post.user_id,
                userName: userInfo.username,
                imageUrl: post.image_url,
                caption: post.caption,
                location: post.location,
                tags: postTags,
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

// Create new post
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

        // Create the post
        const { data: post, error: postError } = await supabase
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

// Get single post
app.get('/api/posts/:id', async (req, res) => {
    try {
        const postId = req.params.id;
        
        const { data: post, error } = await supabase
            .from('posts')
            .select(`
                *,
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

        // Get user info for this post
        const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(post.user_id);
        let userInfo = { fullName: 'Anonymous', username: 'anonymous' };
        
        if (!userError && user) {
            userInfo = getUserInfo(user);
        }

        const postTags = post.post_tags?.map(pt => pt.tags?.name).filter(Boolean) || [];

        const transformedPost = {
            id: post.id,
            userId: post.user_id,
            userName: userInfo.username,
            imageUrl: post.image_url,
            caption: post.caption,
            location: post.location,
            tags: postTags,
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
        if (content !== undefined) updates.caption = content;
        if (location !== undefined) updates.location = location;
        updates.updated_at = new Date().toISOString();

        const { data: post, error: updateError } = await supabase
            .from('posts')
            .update(updates)
            .eq('id', postId)
            .select(`
                *,
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

        const postTags = post.post_tags?.map(pt => pt.tags?.name).filter(Boolean) || [];

        const transformedPost = {
            id: post.id,
            userId: post.user_id,
            userName: userInfo.username,
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

        // Try to delete image from Cloudinary (optional)
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
        const { data: existingLike, error: likeCheckError } = await supabase
            .from('likes')
            .select('id')
            .eq('post_id', postId)
            .eq('user_id', userId)
            .single();

        let liked = false;
        let message = '';

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

            liked = true;
            message = 'Post liked';
        }

        // Get updated like count
        const { data: updatedPost } = await supabase
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
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// 404 handler - this should be LAST
app.use('*', (req, res) => {
    console.log(`404 - Route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        requestedRoute: req.originalUrl,
        availableRoutes: [
            'GET /',
            'GET /api/health',
            'GET /health',
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

// Start server
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
    console.log(`API docs: http://localhost:${PORT}/`);
});

// Handle server errors
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Please kill the process using this port or use a different port.`);
        console.error('To kill the process, run: netstat -ano | findstr :5000');
        console.error('Then: taskkill /PID <PID_NUMBER> /F');
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
});

module.exports = app;