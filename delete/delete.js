const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const rateLimit = require('express-rate-limit');
require('dotenv').config();

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

// Rate limiting for delete operations
const deleteRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // limit each IP to 30 delete requests per windowMs
  message: { error: 'Too many delete requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

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

// Admin authentication middleware (for dangerous operations)
const authenticateAdmin = async (req, res, next) => {
  try {
    await authenticateUser(req, res, async () => {
      // Check if user has admin privileges
      const { data: profile } = await supabase
        .from('profiles')
        .select('user_type, is_admin')
        .eq('id', req.user.id)
        .single();

      if (!profile || (!profile.is_admin && profile.user_type !== 'admin')) {
        return res.status(403).json({ error: 'Admin privileges required' });
      }
      
      next();
    });
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(403).json({ error: 'Admin authentication failed' });
  }
};

// Helper function to extract Cloudinary public ID from URL
const extractPublicIdFromUrl = (imageUrl, folder = null) => {
  try {
    if (!imageUrl || typeof imageUrl !== 'string') {
      return null;
    }

    // Handle Cloudinary URLs with various patterns
    const patterns = [
      /\/upload\/(?:v\d+\/)?(.+?)\./,  // Standard pattern
      /\/image\/upload\/(?:v\d+\/)?(.+?)\./,  // With /image/
      /\/video\/upload\/(?:v\d+\/)?(.+?)\./,  // Video uploads
      /\/raw\/upload\/(?:v\d+\/)?(.+?)\./     // Raw files
    ];

    for (const pattern of patterns) {
      const match = imageUrl.match(pattern);
      if (match && match[1]) {
        let publicId = match[1];
        
        // If a folder is specified and not already in the public ID
        if (folder && !publicId.startsWith(folder + '/')) {
          publicId = `${folder}/${publicId}`;
        }
        
        return publicId;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting public ID from URL:', imageUrl, error);
    return null;
  }
};

// Helper function to delete image from Cloudinary
const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.destroy(publicId, { resource_type: resourceType }, (error, result) => {
      if (error) {
        console.error('Cloudinary delete error:', error);
        reject(error);
      } else {
        console.log('Cloudinary delete result:', result);
        resolve(result);
      }
    });
  });
};

// Helper function to delete multiple images from Cloudinary
const deleteMultipleFromCloudinary = async (imageUrls, folder = null, resourceType = 'image') => {
  const deletionResults = [];
  
  for (const imageUrl of imageUrls) {
    try {
      const publicId = extractPublicIdFromUrl(imageUrl, folder);
      
      if (publicId) {
        console.log(`🗑️ Deleting from Cloudinary: ${publicId}`);
        const result = await deleteFromCloudinary(publicId, resourceType);
        deletionResults.push({
          url: imageUrl,
          publicId: publicId,
          success: result.result === 'ok',
          result: result
        });
      } else {
        console.log(`⚠️ Could not extract public ID from URL: ${imageUrl}`);
        deletionResults.push({
          url: imageUrl,
          publicId: null,
          success: false,
          error: 'Could not extract public ID'
        });
      }
    } catch (error) {
      console.error(`❌ Failed to delete image ${imageUrl}:`, error);
      deletionResults.push({
        url: imageUrl,
        publicId: extractPublicIdFromUrl(imageUrl, folder),
        success: false,
        error: error.message
      });
    }
  }
  
  return deletionResults;
};

// Helper function to get images from any table record
const getImagesFromRecord = (record, imageColumns) => {
  const images = [];
  
  imageColumns.forEach(column => {
    if (record[column]) {
      if (Array.isArray(record[column])) {
        images.push(...record[column]);
      } else if (typeof record[column] === 'string') {
        images.push(record[column]);
      }
    }
  });
  
  return images.filter(img => img && typeof img === 'string' && img.includes('cloudinary'));
};

// Helper function to validate table configuration
const validateTableConfig = (config) => {
  const required = ['tableName', 'idColumn', 'imageColumns'];
  const missing = required.filter(field => !config[field]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
  
  if (!Array.isArray(config.imageColumns) || config.imageColumns.length === 0) {
    throw new Error('imageColumns must be a non-empty array');
  }
  
  return true;
};

// GENERIC DELETE: Remove record and its images from any table
router.delete('/record/:tableName/:recordId', deleteRateLimit, authenticateUser, async (req, res) => {
  try {
    const { tableName, recordId } = req.params;
    const { 
      imageColumns = ['images', 'image_url', 'avatar_url'],
      ownershipColumn = 'user_id',
      cloudinaryFolder = null,
      resourceType = 'image',
      cascadeDeletes = []
    } = req.body;

    const userId = req.user.id;

    console.log(`🗑️ Generic delete request: ${tableName}/${recordId} by user: ${userId}`);

    // Validate inputs
    if (!tableName || !recordId) {
      return res.status(400).json({ error: 'Table name and record ID are required' });
    }

    // Get the record to verify ownership and collect images
    const { data: record, error: fetchError } = await supabase
      .from(tableName)
      .select('*')
      .eq('id', recordId)
      .single();

    if (fetchError || !record) {
      console.log('Record not found:', fetchError?.message);
      return res.status(404).json({ error: 'Record not found' });
    }

    // Check ownership if ownership column exists
    if (ownershipColumn && record[ownershipColumn] && record[ownershipColumn] !== userId) {
      console.log(`❌ Unauthorized delete attempt: User ${userId} tried to delete record owned by ${record[ownershipColumn]}`);
      return res.status(403).json({ error: 'You can only delete your own records' });
    }

    // Extract images from the record
    const recordImages = getImagesFromRecord(record, imageColumns);
    console.log(`📸 Found ${recordImages.length} images to delete from ${tableName}`);

    // Delete images from Cloudinary
    let cloudinaryResults = [];
    if (recordImages.length > 0) {
      console.log('🗑️ Deleting images from Cloudinary...');
      cloudinaryResults = await deleteMultipleFromCloudinary(recordImages, cloudinaryFolder, resourceType);
      
      const successfulDeletes = cloudinaryResults.filter(result => result.success).length;
      const failedDeletes = cloudinaryResults.filter(result => !result.success).length;
      
      console.log(`✅ Cloudinary deletion results: ${successfulDeletes} successful, ${failedDeletes} failed`);
    }

    // Handle cascade deletions
    const cascadeResults = [];
    for (const cascade of cascadeDeletes) {
      try {
        const { table: cascadeTable, foreignKey } = cascade;
        const { error: cascadeError } = await supabase
          .from(cascadeTable)
          .delete()
          .eq(foreignKey, recordId);

        cascadeResults.push({
          table: cascadeTable,
          success: !cascadeError,
          error: cascadeError?.message
        });

        if (cascadeError) {
          console.error(`Error deleting cascade ${cascadeTable}:`, cascadeError);
        } else {
          console.log(`✅ Deleted cascaded records from ${cascadeTable}`);
        }
      } catch (error) {
        console.error(`Error in cascade delete for ${cascade.table}:`, error);
        cascadeResults.push({
          table: cascade.table,
          success: false,
          error: error.message
        });
      }
    }

    // Delete the main record
    const { error: deleteError } = await supabase
      .from(tableName)
      .delete()
      .eq('id', recordId);

    if (deleteError) {
      console.error(`Error deleting record from ${tableName}:`, deleteError);
      return res.status(500).json({ 
        error: `Failed to delete record from ${tableName}`,
        cloudinaryResults: cloudinaryResults,
        cascadeResults: cascadeResults
      });
    }

    console.log(`✅ Successfully deleted record from ${tableName}: ${recordId}`);

    res.json({
      success: true,
      message: `Record and associated images deleted successfully from ${tableName}`,
      tableName: tableName,
      recordId: recordId,
      deletedImages: cloudinaryResults.length,
      cloudinaryResults: cloudinaryResults,
      cascadeResults: cascadeResults
    });

  } catch (error) {
    console.error('Generic delete error:', error);
    res.status(500).json({ error: 'Server error deleting record' });
  }
});

// BULK DELETE: Remove multiple records from any table
router.delete('/records/:tableName/bulk', deleteRateLimit, authenticateUser, async (req, res) => {
  try {
    const { tableName } = req.params;
    const { 
      recordIds,
      imageColumns = ['images', 'image_url', 'avatar_url'],
      ownershipColumn = 'user_id',
      cloudinaryFolder = null,
      resourceType = 'image',
      cascadeDeletes = []
    } = req.body;

    const userId = req.user.id;

    if (!recordIds || !Array.isArray(recordIds) || recordIds.length === 0) {
      return res.status(400).json({ error: 'Record IDs array is required' });
    }

    if (recordIds.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 records can be deleted at once' });
    }

    console.log(`🗑️ Bulk delete request: ${recordIds.length} records from ${tableName} by user: ${userId}`);

    // Get all records to verify ownership and collect images
    const { data: records, error: fetchError } = await supabase
      .from(tableName)
      .select('*')
      .in('id', recordIds);

    if (fetchError) {
      return res.status(500).json({ error: `Failed to fetch records from ${tableName}` });
    }

    // Filter records by ownership if ownership column exists
    let ownedRecords = records;
    let unauthorizedRecords = [];

    if (ownershipColumn) {
      ownedRecords = records.filter(record => record[ownershipColumn] === userId);
      unauthorizedRecords = records.filter(record => record[ownershipColumn] !== userId);

      if (unauthorizedRecords.length > 0) {
        console.log(`❌ Unauthorized delete attempt for ${unauthorizedRecords.length} records`);
      }
    }

    if (ownedRecords.length === 0) {
      return res.status(403).json({ error: 'No owned records found to delete' });
    }

    console.log(`📊 Deleting ${ownedRecords.length} owned records (${unauthorizedRecords.length} unauthorized)`);

    // Collect all images from owned records
    const allImages = [];
    ownedRecords.forEach(record => {
      const recordImages = getImagesFromRecord(record, imageColumns);
      allImages.push(...recordImages);
    });

    console.log(`📸 Total images to delete from Cloudinary: ${allImages.length}`);

    // Delete images from Cloudinary
    let cloudinaryResults = [];
    if (allImages.length > 0) {
      cloudinaryResults = await deleteMultipleFromCloudinary(allImages, cloudinaryFolder, resourceType);
    }

    const ownedRecordIds = ownedRecords.map(record => record.id);

    // Handle cascade deletions
    const cascadeResults = [];
    for (const cascade of cascadeDeletes) {
      try {
        const { table: cascadeTable, foreignKey } = cascade;
        const { error: cascadeError } = await supabase
          .from(cascadeTable)
          .delete()
          .in(foreignKey, ownedRecordIds);

        cascadeResults.push({
          table: cascadeTable,
          success: !cascadeError,
          error: cascadeError?.message
        });
      } catch (error) {
        cascadeResults.push({
          table: cascade.table,
          success: false,
          error: error.message
        });
      }
    }

    // Delete the records
    const { error: deleteError } = await supabase
      .from(tableName)
      .delete()
      .in('id', ownedRecordIds);

    if (deleteError) {
      console.error(`Error bulk deleting from ${tableName}:`, deleteError);
      return res.status(500).json({ error: `Failed to delete records from ${tableName}` });
    }

    const successfulDeletes = cloudinaryResults.filter(result => result.success).length;
    const failedDeletes = cloudinaryResults.filter(result => !result.success).length;

    console.log(`✅ Bulk delete completed: ${ownedRecords.length} records, ${successfulDeletes} images deleted, ${failedDeletes} image deletions failed`);

    res.json({
      success: true,
      message: `Successfully deleted ${ownedRecords.length} records from ${tableName}`,
      tableName: tableName,
      deletedRecords: ownedRecords.length,
      unauthorizedRecords: unauthorizedRecords.length,
      deletedImages: successfulDeletes,
      failedImageDeletions: failedDeletes,
      cloudinaryResults: cloudinaryResults,
      cascadeResults: cascadeResults
    });

  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ error: 'Server error during bulk delete' });
  }
});

// CLEANUP: Remove orphaned images from Cloudinary
router.delete('/cleanup/orphaned/:tableName', deleteRateLimit, authenticateAdmin, async (req, res) => {
  try {
    const { tableName } = req.params;
    const { 
      imageColumns = ['images', 'image_url', 'avatar_url'],
      cloudinaryFolder = null,
      resourceType = 'image'
    } = req.body;

    console.log(`🧹 Orphaned images cleanup for table: ${tableName}`);

    // Get all images from the specified table
    const { data: records, error: fetchError } = await supabase
      .from(tableName)
      .select(imageColumns.join(', '));

    if (fetchError) {
      return res.status(500).json({ error: `Failed to fetch records from ${tableName}` });
    }

    const databaseImages = new Set();
    records.forEach(record => {
      const recordImages = getImagesFromRecord(record, imageColumns);
      recordImages.forEach(img => databaseImages.add(img));
    });

    console.log(`📊 Found ${databaseImages.size} images in database for ${tableName}`);

    // Note: This is a simplified version. In production, you would:
    // 1. Use Cloudinary Admin API to list all resources in the folder
    // 2. Compare with database images
    // 3. Delete orphaned ones

    // For now, return information about database images
    res.json({
      success: true,
      message: `Orphaned image cleanup scan for ${tableName}`,
      tableName: tableName,
      databaseImages: databaseImages.size,
      imageUrls: Array.from(databaseImages),
      note: 'This endpoint needs enhancement with Cloudinary Admin API to actually clean up orphaned images'
    });

  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: 'Server error during cleanup' });
  }
});

// PREVIEW: Show what would be deleted (dry run)
router.get('/preview/:tableName/:recordId', authenticateUser, async (req, res) => {
  try {
    const { tableName, recordId } = req.params;
    const { 
      imageColumns = ['images', 'image_url', 'avatar_url'],
      ownershipColumn = 'user_id',
      cascadeDeletes = []
    } = req.query;

    const userId = req.user.id;

    const { data: record, error } = await supabase
      .from(tableName)
      .select('*')
      .eq('id', recordId)
      .single();

    if (error || !record) {
      return res.status(404).json({ error: 'Record not found' });
    }

    // Check ownership
    if (ownershipColumn && record[ownershipColumn] && record[ownershipColumn] !== userId) {
      return res.status(403).json({ error: 'You can only preview deletion of your own records' });
    }

    // Get images
    const parsedImageColumns = Array.isArray(imageColumns) ? imageColumns : [imageColumns];
    const recordImages = getImagesFromRecord(record, parsedImageColumns);

    // Get cascade counts
    const cascadeCounts = {};
    const parsedCascades = Array.isArray(cascadeDeletes) ? cascadeDeletes : [];
    
    for (const cascade of parsedCascades) {
      if (typeof cascade === 'string') {
        try {
          const parsed = JSON.parse(cascade);
          const { count } = await supabase
            .from(parsed.table)
            .select('*', { count: 'exact', head: true })
            .eq(parsed.foreignKey, recordId);
          
          cascadeCounts[parsed.table] = count || 0;
        } catch (e) {
          cascadeCounts[cascade] = 'Error parsing cascade config';
        }
      } else if (cascade.table && cascade.foreignKey) {
        const { count } = await supabase
          .from(cascade.table)
          .select('*', { count: 'exact', head: true })
          .eq(cascade.foreignKey, recordId);
        
        cascadeCounts[cascade.table] = count || 0;
      }
    }

    res.json({
      success: true,
      tableName: tableName,
      recordId: recordId,
      record: record,
      willDelete: {
        images: recordImages.length,
        imageUrls: recordImages,
        cascadeRecords: cascadeCounts
      },
      warning: 'This action cannot be undone!'
    });

  } catch (error) {
    console.error('Preview delete error:', error);
    res.status(500).json({ error: 'Server error previewing deletion' });
  }
});

// SPECIFIC ENDPOINTS for common tables (backward compatibility)

// Posts
router.delete('/posts/:postId', deleteRateLimit, authenticateUser, async (req, res) => {
  req.body = {
    imageColumns: ['images'],
    ownershipColumn: 'user_id',
    cloudinaryFolder: 'posts',
    cascadeDeletes: [
      { table: 'post_likes', foreignKey: 'post_id' },
      { table: 'post_comments', foreignKey: 'post_id' }
    ]
  };
  
  req.params.tableName = 'posts';
  req.params.recordId = req.params.postId;
  
  // Call the generic delete handler
  return router.stack.find(layer => layer.route?.path === '/record/:tableName/:recordId').route.stack[0].handle(req, res);
});

// User profiles
router.delete('/profiles/:profileId', deleteRateLimit, authenticateUser, async (req, res) => {
  req.body = {
    imageColumns: ['avatar_url', 'cover_image'],
    ownershipColumn: 'id',
    cloudinaryFolder: 'profiles',
    cascadeDeletes: [
      { table: 'posts', foreignKey: 'user_id' },
      { table: 'post_likes', foreignKey: 'user_id' },
      { table: 'post_comments', foreignKey: 'user_id' }
    ]
  };
  
  req.params.tableName = 'profiles';
  req.params.recordId = req.params.profileId;
  
  return router.stack.find(layer => layer.route?.path === '/record/:tableName/:recordId').route.stack[0].handle(req, res);
});

module.exports = router;