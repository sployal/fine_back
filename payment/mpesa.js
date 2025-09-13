const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
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

// M-Pesa Configuration
const MPESA_CONFIG = {
  consumer_key: 'RKNVKZX9aQ1pkfAAA0gM0fadRoJH5ocEjNK0sQmyYB7qln6o',
  consumer_secret: 'GcwX5AEGwJCvAYq2qDxr99Qh4lfiy6GhDKsoDuefRGLyhZotb7o1ckp0CZ548XBk',
  business_short_code: process.env.MPESA_BUSINESS_SHORT_CODE || '174379',
  passkey: process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  callback_url: process.env.MPESA_CALLBACK_URL || 'https://fine-back2.onrender.com/api/payments/mpesa/callback',
  confirmation_url: process.env.MPESA_CONFIRMATION_URL || 'https://fine-back2.onrender.com/api/payments/mpesa/confirmation',
  validation_url: process.env.MPESA_VALIDATION_URL || 'https://fine-back2.onrender.com/api/payments/mpesa/validation',
  // M-Pesa API base URL for token generation and API calls
  base_url: process.env.NODE_ENV === 'sandbox' 
    ? 'https://api.safaricom.co.ke' 
    : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
};

// Get M-Pesa access token
async function getMpesaAccessToken() {
  try {
    const credentials = Buffer.from(
      `${MPESA_CONFIG.consumer_key}:${MPESA_CONFIG.consumer_secret}`
    ).toString('base64');

    const response = await axios.get(
      `${MPESA_CONFIG.base_url}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          'Authorization': `Basic ${credentials}`
        }
      }
    );

    return response.data.access_token;
  } catch (error) {
    console.error('Error getting M-Pesa access token:', error.response?.data || error.message);
    throw new Error('Failed to get M-Pesa access token');
  }
}

// Generate M-Pesa password
function generateMpesaPassword() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(
    `${MPESA_CONFIG.business_short_code}${MPESA_CONFIG.passkey}${timestamp}`
  ).toString('base64');
  
  return { password, timestamp };
}

// CORE M-PESA ENDPOINTS

// Initiate STK Push
router.post('/mpesa/stk-push', async (req, res) => {
  try {
    const { 
      phone_number, 
      amount, 
      transaction_desc, 
      account_reference,
      user_id,
      photo_ids 
    } = req.body;

    // Validate required fields
    if (!phone_number || !amount || !user_id || !photo_ids) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Validate phone number format
    const cleanPhone = phone_number.replace(/\D/g, '');
    if (!cleanPhone.match(/^254\d{9}$/)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number format. Use 254XXXXXXXXX'
      });
    }

    // Get access token
    const accessToken = await getMpesaAccessToken();
    const { password, timestamp } = generateMpesaPassword();

    // Create transaction record
    const transactionId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const { error: dbError } = await supabase
      .from('mpesa_transactions')
      .insert([{
        transaction_id: transactionId,
        user_id: user_id,
        phone_number: cleanPhone,
        amount: parseFloat(amount),
        photo_ids: photo_ids,
        status: 'initiated',
        created_at: new Date().toISOString()
      }]);

    if (dbError) {
      console.error('Database error:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create transaction record'
      });
    }

    // STK Push request
    const stkPushData = {
      BusinessShortCode: MPESA_CONFIG.business_short_code,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(parseFloat(amount)),
      PartyA: cleanPhone,
      PartyB: MPESA_CONFIG.business_short_code,
      PhoneNumber: cleanPhone,
      CallBackURL: MPESA_CONFIG.callback_url,
      AccountReference: account_reference || transactionId,
      TransactionDesc: transaction_desc || 'Photo Purchase Payment'
    };

    console.log('Initiating STK Push for:', {
      phone: cleanPhone,
      amount: amount,
      transactionId: transactionId
    });

    const stkResponse = await axios.post(
      `${MPESA_CONFIG.base_url}/mpesa/stkpush/v1/processrequest`,
      stkPushData,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (stkResponse.data.ResponseCode === '0') {
      // Update transaction with checkout request ID
      await supabase
        .from('mpesa_transactions')
        .update({
          checkout_request_id: stkResponse.data.CheckoutRequestID,
          merchant_request_id: stkResponse.data.MerchantRequestID,
          status: 'pending'
        })
        .eq('transaction_id', transactionId);

      res.json({
        success: true,
        message: 'STK Push sent successfully',
        transaction_id: transactionId,
        checkout_request_id: stkResponse.data.CheckoutRequestID,
        merchant_request_id: stkResponse.data.MerchantRequestID
      });
    } else {
      // Update transaction status to failed
      await supabase
        .from('mpesa_transactions')
        .update({ status: 'failed', error_message: stkResponse.data.ResponseDescription })
        .eq('transaction_id', transactionId);

      res.status(400).json({
        success: false,
        error: stkResponse.data.ResponseDescription || 'STK Push failed'
      });
    }

  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate payment'
    });
  }
});

// M-Pesa Callback
router.post('/mpesa/callback', async (req, res) => {
  try {
    console.log('M-Pesa Callback received:', JSON.stringify(req.body, null, 2));

    const { Body } = req.body;
    const stkCallback = Body?.stkCallback;

    if (!stkCallback) {
      return res.status(400).json({ error: 'Invalid callback data' });
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const merchantRequestId = stkCallback.MerchantRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;

    // Find transaction
    const { data: transaction, error } = await supabase
      .from('mpesa_transactions')
      .select('*')
      .eq('checkout_request_id', checkoutRequestId)
      .single();

    if (error || !transaction) {
      console.error('Transaction not found:', checkoutRequestId);
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (resultCode === 0) {
      // Payment successful
      const callbackMetadata = stkCallback.CallbackMetadata?.Item || [];
      const mpesaReceiptNumber = callbackMetadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const transactionDate = callbackMetadata.find(item => item.Name === 'TransactionDate')?.Value;
      const phoneNumber = callbackMetadata.find(item => item.Name === 'PhoneNumber')?.Value;

      // Update transaction status
      await supabase
        .from('mpesa_transactions')
        .update({
          status: 'completed',
          mpesa_receipt_number: mpesaReceiptNumber,
          transaction_date: transactionDate,
          phone_number: phoneNumber?.toString(),
          callback_data: req.body,
          completed_at: new Date().toISOString()
        })
        .eq('transaction_id', transaction.transaction_id);

      // Process photo payment - move images from unpaid to paid
      await processPhotoPayment(transaction);

      console.log('Payment completed successfully:', mpesaReceiptNumber);
    } else {
      // Payment failed
      await supabase
        .from('mpesa_transactions')
        .update({
          status: 'failed',
          error_message: resultDesc,
          callback_data: req.body
        })
        .eq('transaction_id', transaction.transaction_id);

      console.log('Payment failed:', resultDesc);
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });

  } catch (error) {
    console.error('Callback processing error:', error);
    res.status(500).json({ error: 'Callback processing failed' });
  }
});

// Query transaction status
router.get('/mpesa/transaction/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;

    const { data: transaction, error } = await supabase
      .from('mpesa_transactions')
      .select('*')
      .eq('transaction_id', transactionId)
      .single();

    if (error || !transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      transaction: {
        transaction_id: transaction.transaction_id,
        status: transaction.status,
        amount: transaction.amount,
        phone_number: transaction.phone_number,
        mpesa_receipt_number: transaction.mpesa_receipt_number,
        created_at: transaction.created_at,
        completed_at: transaction.completed_at,
        error_message: transaction.error_message
      }
    });

  } catch (error) {
    console.error('Transaction query error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to query transaction'
    });
  }
});

// Validation endpoint (required by Safaricom)
router.post('/mpesa/validation', (req, res) => {
  console.log('M-Pesa Validation:', req.body);
  res.json({
    ResultCode: 0,
    ResultDesc: 'Success'
  });
});

// Confirmation endpoint (required by Safaricom)
router.post('/mpesa/confirmation', (req, res) => {
  console.log('M-Pesa Confirmation:', req.body);
  res.json({
    ResultCode: 0,
    ResultDesc: 'Success'
  });
});

// TRANSACTION MANAGEMENT ENDPOINTS

// Update photo payment status
router.post('/photos/update-payment-status', authenticateUser, async (req, res) => {
  try {
    const { photoIds, userId, paymentStatus } = req.body;

    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'photoIds array is required' 
      });
    }

    if (!userId || !paymentStatus) {
      return res.status(400).json({ 
        success: false, 
        message: 'userId and paymentStatus are required' 
      });
    }

    // Ensure user can only update their own photos
    if (userId !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Cannot update payment status for another user' 
      });
    }

    console.log(`🔄 Updating payment status for user ${userId}, photos: ${photoIds.join(', ')}`);

    if (paymentStatus === 'paid') {
      // Get the current photos record
      const { data: photosRecord, error: fetchError } = await supabase
        .from('photos')
        .select('unpaid_images, paid_images')
        .eq('recipient_id', userId)
        .single();

      if (fetchError) {
        console.error('Error fetching photos record:', fetchError);
        return res.status(500).json({ 
          success: false, 
          message: 'Failed to fetch photos record' 
        });
      }

      if (!photosRecord) {
        return res.status(404).json({ 
          success: false, 
          message: 'Photos record not found' 
        });
      }

      const unpaidImages = photosRecord.unpaid_images || [];
      const paidImages = photosRecord.paid_images || [];

      // Move specified photos from unpaid to paid
      const updatedUnpaidImages = unpaidImages.filter(img => !photoIds.includes(img.id));
      const photosToMove = unpaidImages.filter(img => photoIds.includes(img.id));
      
      if (photosToMove.length === 0) {
        return res.status(400).json({ 
          success: false, 
          message: 'No matching unpaid photos found' 
        });
      }

      const updatedPaidImages = [...paidImages, ...photosToMove];

      // Update the photos record
      const { error: updateError } = await supabase
        .from('photos')
        .update({
          unpaid_images: updatedUnpaidImages,
          paid_images: updatedPaidImages
        })
        .eq('recipient_id', userId);

      if (updateError) {
        console.error('Error updating photos record:', updateError);
        return res.status(500).json({ 
          success: false, 
          message: 'Failed to update photos record' 
        });
      }

      console.log(`✅ Successfully moved ${photosToMove.length} photos to paid status for user ${userId}`);

      res.json({
        success: true,
        message: `Successfully updated payment status for ${photosToMove.length} photos`,
        movedPhotos: photosToMove.length,
        updatedUnpaidCount: updatedUnpaidImages.length,
        updatedPaidCount: updatedPaidImages.length
      });

    } else {
      res.status(400).json({ 
        success: false, 
        message: 'Invalid payment status. Only "paid" status updates are supported.' 
      });
    }

  } catch (error) {
    console.error('Update payment status error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error updating payment status' 
    });
  }
});

// Get payment transactions for a user
router.get('/transactions', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    console.log(`📋 Fetching payment transactions for user: ${userId}`);

    let query = supabase
      .from('mpesa_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    // Filter by status if provided
    if (status && ['initiated', 'pending', 'completed', 'failed', 'cancelled', 'timeout'].includes(status)) {
      query = query.eq('status', status);
    }

    const { data: transactions, error, count } = await query
      .range(offset, offset + parseInt(limit) - 1);

    if (error) {
      console.error('Error fetching payment transactions:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch payment transactions' 
      });
    }

    res.json({
      success: true,
      transactions: transactions || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        hasMore: (offset + parseInt(limit)) < (count || 0)
      }
    });

  } catch (error) {
    console.error('Get payment transactions error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error fetching payment transactions' 
    });
  }
});

// Get payment transaction summary for a user
router.get('/summary', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;

    console.log(`📊 Fetching payment summary for user: ${userId}`);

    // Calculate summary from mpesa_transactions table
    const { data: transactions, error } = await supabase
      .from('mpesa_transactions')
      .select('status, amount, created_at')
      .eq('user_id', userId);

    if (error) {
      console.error('Error fetching transactions for summary:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch payment summary' 
      });
    }

    const summary = {
      user_id: userId,
      total_transactions: transactions.length,
      completed_transactions: transactions.filter(t => t.status === 'completed').length,
      pending_transactions: transactions.filter(t => t.status === 'pending').length,
      failed_transactions: transactions.filter(t => t.status === 'failed').length,
      total_amount_paid: transactions
        .filter(t => t.status === 'completed')
        .reduce((sum, t) => sum + (t.amount || 0), 0),
      average_transaction_amount: 0,
      last_transaction_date: transactions.length > 0 ? 
        Math.max(...transactions.map(t => new Date(t.created_at).getTime())) : null
    };

    if (summary.completed_transactions > 0) {
      summary.average_transaction_amount = summary.total_amount_paid / summary.completed_transactions;
    }

    if (summary.last_transaction_date) {
      summary.last_transaction_date = new Date(summary.last_transaction_date).toISOString();
    }

    res.json({
      success: true,
      summary: summary
    });

  } catch (error) {
    console.error('Get payment summary error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error fetching payment summary' 
    });
  }
});

// Cleanup expired transactions endpoint
router.post('/cleanup-expired', authenticateUser, async (req, res) => {
  try {
    console.log('🧹 Cleaning up expired payment transactions...');

    // Delete transactions older than 24 hours that are still pending or initiated
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const { data: expiredTransactions, error: fetchError } = await supabase
      .from('mpesa_transactions')
      .select('transaction_id')
      .in('status', ['pending', 'initiated'])
      .lt('created_at', cutoffTime);

    if (fetchError) {
      console.error('Error fetching expired transactions:', fetchError);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch expired transactions' 
      });
    }

    if (!expiredTransactions || expiredTransactions.length === 0) {
      return res.json({
        success: true,
        message: 'No expired transactions found',
        deletedCount: 0
      });
    }

    // Update expired transactions to 'timeout' status
    const { error: updateError } = await supabase
      .from('mpesa_transactions')
      .update({ status: 'timeout', error_message: 'Transaction expired' })
      .in('status', ['pending', 'initiated'])
      .lt('created_at', cutoffTime);

    if (updateError) {
      console.error('Error updating expired transactions:', updateError);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to update expired transactions' 
      });
    }

    const deletedCount = expiredTransactions.length;
    console.log(`✅ Updated ${deletedCount} expired transactions to timeout status`);

    res.json({
      success: true,
      message: `Successfully updated ${deletedCount} expired transactions`,
      deletedCount
    });

  } catch (error) {
    console.error('Cleanup expired transactions error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error cleaning up expired transactions' 
    });
  }
});

// HELPER FUNCTIONS

// Process photo payment after successful M-Pesa transaction
async function processPhotoPayment(transaction) {
  try {
    const photoIds = transaction.photo_ids;
    const userId = transaction.user_id;

    // Get user's photo record
    const { data: photoRecord, error: fetchError } = await supabase
      .from('photos')
      .select('*')
      .eq('recipient_id', userId)
      .single();

    if (fetchError || !photoRecord) {
      console.error('Photo record not found for user:', userId);
      return;
    }

    const unpaidImages = photoRecord.unpaid_images || [];
    const paidImages = photoRecord.paid_images || [];

    // Move purchased images from unpaid to paid
    const imagesToMove = unpaidImages.filter(image => 
      photoIds.includes(image.id)
    );

    const remainingUnpaidImages = unpaidImages.filter(image => 
      !photoIds.includes(image.id)
    );

    const updatedPaidImages = [...paidImages, ...imagesToMove.map(image => ({
      ...image,
      paid_at: new Date().toISOString(),
      transaction_id: transaction.transaction_id
    }))];

    // Update photos table
    const { error: updateError } = await supabase
      .from('photos')
      .update({
        unpaid_images: remainingUnpaidImages,
        paid_images: updatedPaidImages,
        updated_at: new Date().toISOString()
      })
      .eq('recipient_id', userId);

    if (updateError) {
      console.error('Error updating photo record:', updateError);
    } else {
      console.log(`Successfully moved ${imagesToMove.length} images to paid for user:`, userId);
    }

  } catch (error) {
    console.error('Error processing photo payment:', error);
  }
}

// Periodic cleanup (runs every hour)
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds

const cleanupInterval = setInterval(async () => {
  try {
    console.log('🕐 Running scheduled cleanup of expired payment transactions...');
    
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const { data: expiredTransactions, error: fetchError } = await supabase
      .from('mpesa_transactions')
      .select('transaction_id')
      .in('status', ['pending', 'initiated'])
      .lt('created_at', cutoffTime);

    if (fetchError) {
      console.error('Scheduled cleanup fetch error:', fetchError);
      return;
    }

    if (expiredTransactions && expiredTransactions.length > 0) {
      const { error: updateError } = await supabase
        .from('mpesa_transactions')
        .update({ status: 'timeout', error_message: 'Transaction expired' })
        .in('status', ['pending', 'initiated'])
        .lt('created_at', cutoffTime);

      if (updateError) {
        console.error('Scheduled cleanup update error:', updateError);
      } else {
        console.log(`✅ Scheduled cleanup updated ${expiredTransactions.length} expired transactions`);
      }
    }
  } catch (error) {
    console.error('Scheduled cleanup error:', error);
  }
}, CLEANUP_INTERVAL);

console.log(`⏰ Scheduled payment transaction cleanup every ${CLEANUP_INTERVAL / 1000 / 60} minutes`);

// Cleanup interval on module unload
process.on('SIGTERM', () => {
  clearInterval(cleanupInterval);
});
process.on('SIGINT', () => {
  clearInterval(cleanupInterval);
});

module.exports = router;