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
        fileSize: 10 * 1024 * 1024, // 10MB limit (increased from 5MB)
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
                    { width: 800, height: 800, crop: 'limit', quality: 'auto:good' },
                    { fetch_format: 'auto' }
                ]
            },
            (error, result) => {
                if (error) {
                    console.error('Cloudinary upload error:', error);
                    reject(error);
                } else {
                    console.log('Cloudinary upload success:', result.secure_url);
                    resolve(result.secure_url);
                }
            }
        ).end(buffer);
    });
};

// Helper function to get user info with proper priority system
const getUserInfo = (authUser) => {
    if (!authUser) return null;
    
    // Use user_metadata instead of raw_user_meta_data
    const metadata = authUser.user_metadata || {};
    
    // Get full name
    const fullName = metadata.full_name || metadata.name || authUser.email.split('@')[0];
    
    // Extract first name for fallback
    const firstName = fullName.split(' ')[0];
    
    // Priority: username > firstName > email prefix
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
        username: username,
        accountType: metadata.account_type || 'free'
    };
};

// Helper function to handle database errors
const handleDatabaseError = (error) => {
    console.error('Database error:', error);
    if (error.code === '23505') {
        return 'Duplicate entry';
    }
    if (error.code === '42703') {
        return 'Column not found in database schema';
    }
    if (error.code === 'PGRST116') {
        return 'Resource not found';
    }
    return error.message || 'Database operation failed';
};

// Validation helper functions
const validatePostData = (data) => {
    const errors = [];
    
    if (!data.content && !data.caption) {
        errors.push('Post caption/content is required');
    }
    
    if (data.content && data.content.trim().length === 0) {
        errors.push('Post content cannot be empty');
    }
    
    if (data.caption && data.caption.trim().length === 0) {
        errors.push('Post caption cannot be empty');
    }
    
    if (!data.images || !Array.isArray(data.images) || data.images.length === 0) {
        errors.push('At least one image is required');
    }
    
    if (!data.userId) {
        errors.push('User ID is required');
    }
    
    if (data.tags && (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag !== 'string'))) {
        errors.push('Tags must be an array of strings');
    }
    
    return errors;
};

// ROUTES

// Root route
app.get('/', (req, res) => {
    res.json({ 
        message: 'Welcome to Flodaz Community API',
        version: '2.1.0',
        status: 'running',
        server_time: new Date().toISOString(),
        endpoints: {
            health: 'GET /api/health',
            posts: 'GET /api/posts',
            createPost: 'POST /api/posts',
            getPost: 'GET /api/posts/:id',
            updatePost: 'PUT /api/posts/:id',
            deletePost: 'DELETE /api/posts/:id',
            getUserById: 'GET /api/users/:userId',
            uploadImages: 'POST /api/upload-images',
            likePost: 'POST /api/posts/:id/like',
            getTags: 'GET /api/tags'
        }
    });
});

// Health check
app.get('/api/health', async (req, res) => {
    try {
        // Test Supabase connection
        const { data, error } = await supabase.from('posts').select('count').limit(1);
        
        res.json({ 
            status: 'OK', 
            timestamp: new Date().toISOString(),
            message: 'Server is running successfully!',
            database: error ? `Connection failed: ${error.message}` : 'Connected',
            cloudinary: process.env.CLOUDINARY_CLOUD_NAME ? 'Configured' : 'Not configured'
        });
    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({
            status: 'ERROR',
            timestamp: new Date().toISOString(),
            message: 'Server health check failed',
            error: error.message
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
        
        if (!userId) {
            return res.status(400).json({ 
                success: false, 
                error: 'User ID is required' 
            });
        }
        
        const { data: { user }, error } = await supabase.auth.admin.getUserById(userId);
        
        if (error || !user) {
            console.error('Get user error:', error);
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
            error: 'Failed to fetch user: ' + error.message 
        });
    }
});

// Image upload endpoint
app.post('/api/upload-images', upload.array('images', 5), async (req, res) => {
    try {
        console.log('Upload request received');
        console.log('Files received:', req.files ? req.files.length : 0);
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No images provided'
            });
        }

        console.log('Starting image uploads to Cloudinary...');
        const uploadPromises = req.files.map((file, index) => {
            console.log(`Uploading file ${index + 1}/${req.files.length}:`, file.originalname);
            return uploadImageToCloudinary(file.buffer);
        });

        const imageUrls = await Promise.all(uploadPromises);

        console.log('All images uploaded successfully:', imageUrls);

        res.status(200).json({
            success: true,
            imageUrls,
            count: imageUrls.length,
            message: `${imageUrls.length} image(s) uploaded successfully`
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to upload images: ' + error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Get posts with pagination and user information
app.get('/api/posts', async (req, res) => {
    try {
        const { page = 1, limit = 10, user_id, tag } = req.query;
        const offset = (page - 1) * limit;
        
        console.log(`Fetching posts - page: ${page}, limit: ${limit}, user_id: ${user_id}, tag: ${tag}`);
        
        // Build query
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
            // For tag filtering, we need to join through post_tags
            query = query.contains('post_tags.tags.name', [tag]);
        }
        
        // Apply pagination
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
        const userMap = {};
        
        if (userIds.length > 0) {
            try {
                const { data: { users }, error: usersError } = await supabase.auth.admin.listUsers();
                
                if (!usersError && users) {
                    users.forEach(user => {
                        userMap[user.id] = getUserInfo(user);
                    });
                }
            } catch (userError) {
                console.warn('Failed to fetch user info:', userError);
            }
        }

        // Transform posts to match Flutter app expectations
        const transformedPosts = posts.map(post => {
            const userInfo = userMap[post.user_id] || {
                fullName: 'Anonymous User',
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

        console.log(`Successfully fetched ${transformedPosts.length} posts`);

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
        // Accept both 'content' and 'caption' fields for flexibility
        const { content, caption, tags = [], images = [], location, userId } = req.body;
        
        console.log('Creating post with data:', { 
            content: content ? content.substring(0, 50) + '...' : 'none', 
            caption: caption ? caption.substring(0, 50) + '...' : 'none',
            tags, 
            images: images.map(url => url.substring(0, 50) + '...'), 
            location, 
            userId 
        });
        
        // Validation using the helper function
        const postData = { 
            content: content || caption, 
            caption: caption || content, 
            tags, 
            images, 
            location, 
            userId 
        };
        const validationErrors = validatePostData(postData);
        
        if (validationErrors.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: validationErrors
            });
        }

        // Use the final caption (content takes priority if both are provided)
        const finalCaption = content || caption;

        console.log('Inserting post into database...');
        
        // Create the post with explicit column mapping
        const { data: post, error: postError } = await supabase
            .from('posts')
            .insert({
                user_id: userId,
                image_url: images[0], // Primary image
                caption: finalCaption, // Map to caption column
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
                error: handleDatabaseError(postError),
                details: process.env.NODE_ENV === 'development' ? postError : undefined
            });
        }

        console.log('Post created successfully:', post.id);

        // Handle tags if provided
        const processedTags = [];
        if (tags && tags.length > 0) {
            console.log('Processing tags:', tags);
            
            for (const tagName of tags) {
                if (tagName && tagName.trim()) {
                    const cleanTagName = tagName.toLowerCase().trim();
                    
                    try {
                        // Try to get existing tag
                        let { data: tag, error: tagError } = await supabase
                            .from('tags')
                            .select('id')
                            .eq('name', cleanTagName)
                            .single();

                        // If tag doesn't exist, create it
                        if (tagError && tagError.code === 'PGRST116') {
                            console.log('Creating new tag:', cleanTagName);
                            const { data: newTag, error: createTagError } = await supabase
                                .from('tags')
                                .insert({ name: cleanTagName })
                                .select('id')
                                .single();

                            if (createTagError) {
                                console.error('Tag creation error:', createTagError);
                                continue;
                            }
                            tag = newTag;
                        } else if (tagError) {
                            console.error('Tag fetch error:', tagError);
                            continue;
                        }

                        if (tag && tag.id) {
                            // Link tag to post
                            const { error: linkError } = await supabase
                                .from('post_tags')
                                .insert({
                                    post_id: post.id,
                                    tag_id: tag.id
                                });

                            if (!linkError) {
                                processedTags.push(cleanTagName);
                                console.log('Tag linked successfully:', cleanTagName);
                            } else {
                                console.error('Tag linking error:', linkError);
                            }
                        }
                    } catch (tagProcessError) {
                        console.error('Error processing tag:', cleanTagName, tagProcessError);
                        continue;
                    }
                }
            }
            
            console.log('Processed tags:', processedTags);
        }

        // Get user info for response
        let userInfo = { fullName: 'Anonymous User', username: 'anonymous' };
        
        try {
            const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);
            if (!userError && user) {
                userInfo = getUserInfo(user);
            }
        } catch (userFetchError) {
            console.warn('Failed to fetch user info for response:', userFetchError);
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
            },
            message: 'Post created successfully'
        };

        console.log('Post creation completed successfully');
        res.status(201).json(response);
        
    } catch (error) {
        console.error('Create post error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create post: ' + error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Get single post
app.get('/api/posts/:id', async (req, res) => {
    try {
        const postId = req.params.id;
        
        if (!postId) {
            return res.status(400).json({
                success: false,
                error: 'Post ID is required'
            });
        }
        
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
        let userInfo = { fullName: 'Anonymous User', username: 'anonymous' };
        
        try {
            const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(post.user_id);
            if (!userError && user) {
                userInfo = getUserInfo(user);
            }
        } catch (userError) {
            console.warn('Failed to fetch user info:', userError);
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
        const { content, caption, location, tags, userId } = req.body;

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
        if (content !== undefined || caption !== undefined) {
            updates.caption = content || caption;
        }
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
        let finalTags = post.post_tags?.map(pt => pt.tags?.name).filter(Boolean) || [];
        
        if (tags !== undefined) {
            // Remove existing tags
            await supabase
                .from('post_tags')
                .delete()
                .eq('post_id', postId);

            // Add new tags
            const processedTags = [];
            for (const tagName of tags) {
                if (tagName && tagName.trim()) {
                    const cleanTagName = tagName.toLowerCase().trim();
                    
                    let { data: tag, error: tagError } = await supabase
                        .from('tags')
                        .select('id')
                        .eq('name', cleanTagName)
                        .single();

                    if (tagError && tagError.code === 'PGRST116') {
                        const { data: newTag, error: createTagError } = await supabase
                            .from('tags')
                            .insert({ name: cleanTagName })
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
                            processedTags.push(cleanTagName);
                        }
                    }
                }
            }
            finalTags = processedTags;
        }

        // Get user info
        let userInfo = { username: 'anonymous' };
        
        try {
            const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(post.user_id);
            if (!userError && user) {
                userInfo = getUserInfo(user);
            }
        } catch (userError) {
            console.warn('Failed to fetch user info:', userError);
        }

        const transformedPost = {
            id: post.id,
            userId: post.user_id,
            userName: userInfo.username,
            imageUrl: post.image_url,
            caption: post.caption,
            location: post.location,
            tags: finalTags,
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
                // Extract public_id from URL
                const urlParts = imageUrl.split('/');
                const filename = urlParts[urlParts.length - 1];
                const publicId = `flodaz_community/${filename.split('.')[0]}`;
                await cloudinary.uploader.destroy(publicId);
                console.log('Image deleted from Cloudinary:', publicId);
            }
        } catch (cloudinaryError) {
            console.warn('Failed to delete image from Cloudinary:', cloudinaryError.message);
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

        // Get updated like count (the trigger should have updated it)
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
        const { limit = 20 } = req.query;
        
        // Get tags with post count for popularity
        const { data: tags, error } = await supabase
            .from('tags')
            .select(`
                name,
                post_tags (count)
            `)
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (error) {
            console.error('Get tags error:', error);
            return res.status(500).json({
                success: false,
                error: handleDatabaseError(error)
            });
        }

        // Transform to include popularity count
        const transformedTags = tags.map(tag => ({
            name: tag.name,
            count: tag.post_tags?.length || 0
        }));

        // Sort by popularity (post count) then alphabetically
        transformedTags.sort((a, b) => {
            if (b.count !== a.count) {
                return b.count - a.count; // Higher count first
            }
            return a.name.localeCompare(b.name); // Alphabetical if same count
        });

        res.status(200).json({
            success: true,
            tags: transformedTags.map(tag => tag.name), // Just return names for simplicity
            tagDetails: transformedTags, // Include counts if needed
            total: transformedTags.length
        });
    } catch (error) {
        console.error('Get tags error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get tags: ' + error.message
        });
    }
});

// Get comments for a post (future feature)
app.get('/api/comments/:postId', async (req, res) => {
    try {
        const { postId } = req.params;
        const { page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        if (!postId) {
            return res.status(400).json({
                success: false,
                error: 'Post ID is required'
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

        // Get comments
        const { data: comments, error } = await supabase
            .from('comments')
            .select('*')
            .eq('post_id', postId)
            .is('parent_comment_id', null) // Only top-level comments
            .order('created_at', { ascending: false })
            .range(offset, offset + parseInt(limit) - 1);

        if (error) {
            return res.status(500).json({
                success: false,
                error: handleDatabaseError(error)
            });
        }

        // Get user info for each comment
        const userIds = [...new Set(comments.map(comment => comment.user_id))];
        const userMap = {};
        
        if (userIds.length > 0) {
            try {
                const { data: { users }, error: usersError } = await supabase.auth.admin.listUsers();
                
                if (!usersError && users) {
                    users.forEach(user => {
                        userMap[user.id] = getUserInfo(user);
                    });
                }
            } catch (userError) {
                console.warn('Failed to fetch user info for comments:', userError);
            }
        }

        // Transform comments
        const transformedComments = comments.map(comment => {
            const userInfo = userMap[comment.user_id] || {
                username: 'anonymous',
                fullName: 'Anonymous User'
            };

            return {
                id: comment.id,
                postId: comment.post_id,
                userId: comment.user_id,
                userName: userInfo.username,
                content: comment.content,
                likes: comment.likes || 0,
                createdAt: comment.created_at,
                updatedAt: comment.updated_at
            };
        });

        res.status(200).json({
            success: true,
            comments: transformedComments,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: transformedComments.length
            }
        });
    } catch (error) {
        console.error('Get comments error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get comments: ' + error.message
        });
    }
});

// Create comment (future feature)
app.post('/api/comments', async (req, res) => {
    try {
        const { postId, userId, content, parentCommentId } = req.body;

        // Validation
        if (!postId || !userId || !content) {
            return res.status(400).json({
                success: false,
                error: 'Post ID, User ID, and content are required'
            });
        }

        if (content.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Comment content cannot be empty'
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

        // Create comment
        const { data: comment, error: commentError } = await supabase
            .from('comments')
            .insert({
                post_id: postId,
                user_id: userId,
                content: content.trim(),
                parent_comment_id: parentCommentId || null,
                likes: 0
            })
            .select()
            .single();

        if (commentError) {
            return res.status(500).json({
                success: false,
                error: handleDatabaseError(commentError)
            });
        }

        // Get user info for response
        let userInfo = { username: 'anonymous' };
        try {
            const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);
            if (!userError && user) {
                userInfo = getUserInfo(user);
            }
        } catch (userError) {
            console.warn('Failed to fetch user info for comment:', userError);
        }

        const response = {
            success: true,
            comment: {
                id: comment.id,
                postId: comment.post_id,
                userId: comment.user_id,
                userName: userInfo.username,
                content: comment.content,
                likes: comment.likes,
                createdAt: comment.created_at,
                updatedAt: comment.updated_at
            },
            message: 'Comment created successfully'
        };

        res.status(201).json(response);
    } catch (error) {
        console.error('Create comment error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create comment: ' + error.message
        });
    }
});

// Search posts
app.get('/api/search/posts', async (req, res) => {
    try {
        const { q: query, page = 1, limit = 10, tags, user } = req.query;
        const offset = (page - 1) * limit;

        if (!query || query.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Search query is required'
            });
        }

        console.log(`Searching posts for: "${query}"`);

        // Build search query
        let searchQuery = supabase
            .from('posts')
            .select(`
                *,
                post_tags (
                    tags (
                        name
                    )
                )
            `)
            .or(`caption.ilike.%${query}%,location.ilike.%${query}%`)
            .order('created_at', { ascending: false });

        // Apply filters
        if (tags) {
            const tagList = Array.isArray(tags) ? tags : [tags];
            // This would need a more complex query for proper tag filtering
            console.log('Tag filtering requested:', tagList);
        }

        if (user) {
            searchQuery = searchQuery.eq('user_id', user);
        }

        // Apply pagination
        const { data: posts, error } = await searchQuery
            .range(offset, offset + parseInt(limit) - 1);

        if (error) {
            console.error('Search posts error:', error);
            return res.status(500).json({
                success: false,
                error: handleDatabaseError(error)
            });
        }

        // Get user information for each post
        const userIds = [...new Set(posts.map(post => post.user_id))];
        const userMap = {};
        
        if (userIds.length > 0) {
            try {
                const { data: { users }, error: usersError } = await supabase.auth.admin.listUsers();
                
                if (!usersError && users) {
                    users.forEach(user => {
                        userMap[user.id] = getUserInfo(user);
                    });
                }
            } catch (userError) {
                console.warn('Failed to fetch user info for search:', userError);
            }
        }

        // Transform posts
        const transformedPosts = posts.map(post => {
            const userInfo = userMap[post.user_id] || {
                fullName: 'Anonymous User',
                username: 'anonymous'
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

        res.status(200).json({
            success: true,
            posts: transformedPosts,
            query,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: transformedPosts.length
            }
        });
    } catch (error) {
        console.error('Search posts error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to search posts: ' + error.message
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
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
                success: false,
                error: 'Too many files. Maximum is 5 files.'
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
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
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
            'GET /api/users/:userId',
            'GET /api/comments/:postId',
            'POST /api/comments',
            'GET /api/search/posts'
        ]
    });
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
    console.log(`Received ${signal}. Starting graceful shutdown...`);
    server.close(() => {
        console.log('Server closed successfully');
        process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📚 API docs: http://localhost:${PORT}/`);
    console.log(`☁️ Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? 'Configured' : 'Not configured'}`);
    console.log(`🗄️ Database: ${process.env.SUPABASE_URL ? 'Connected' : 'Not configured'}`);
});

// Handle server errors
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use.`);
        console.error('To kill the existing process:');
        console.error(`   - Windows: netstat -ano | findstr :${PORT} then taskkill /PID <PID> /F`);
        console.error(`   - Mac/Linux: lsof -ti:${PORT} | xargs kill -9`);
    } else {
        console.error('❌ Server error:', err);
    }
    process.exit(1);
});

// Handle process signals for graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
});

module.exports = app;