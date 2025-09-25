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
      return res.status(401).json({ 
        success: false,
        error: 'Missing or invalid authorization header' 
      });
    }

    const token = authHeader.split(' ')[1];
    
    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      console.log('Authentication error:', error?.message);
      return res.status(401).json({ 
        success: false,
        error: 'Invalid or expired token' 
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ 
      success: false,
      error: 'Authentication failed' 
    });
  }
};

// M-Pesa Configuration - SANDBOX Mode
const MPESA_CONFIG = {
  consumer_key: 'RKNVKZX9aQ1pkfAAA0gM0fadRoJH5ocEjNK0sQmyYB7qln6o',
  consumer_secret: 'GcwX5AEGwJCvAYq2qDxr99Qh4lfiy6GhDKsoDuefRGLyhZotb7o1ckp0CZ548XBk',
  business_short_code: '174379',
  passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  
  callback_url: process.env.MPESA_CALLBACK_URL || 'https://fine-back2.onrender.com/api/payments/mpesa/callback',
  confirmation_url: process.env.MPESA_CONFIRMATION_URL || 'https://fine-back2.onrender.com/api/payments/mpesa/confirmation',
  validation_url: process.env.MPESA_VALIDATION_URL || 'https://fine-back2.onrender.com/api/payments/mpesa/validation',
  
  oauth_url: 'https://sandbox.safaricom.co.ke',
  api_url: 'https://sandbox.safaricom.co.ke'
};

console.log('🚀 M-Pesa SANDBOX Server Starting...');
console.log('📱 OAuth URL:', MPESA_CONFIG.oauth_url);
console.log('🌐 API URL:', MPESA_CONFIG.api_url);
console.log('🏢 Business Short Code:', MPESA_CONFIG.business_short_code);
console.log('📞 Callback URL:', MPESA_CONFIG.callback_url);

// Utility: Get M-Pesa access token
async function getMpesaAccessToken() {
  try {
    const credentials = Buffer.from(
      `${MPESA_CONFIG.consumer_key}:${MPESA_CONFIG.consumer_secret}`
    ).toString('base64');

    const tokenUrl = `${MPESA_CONFIG.oauth_url}/oauth/v1/generate?grant_type=client_credentials`;
    console.log('🔑 Requesting SANDBOX access token...');

    const response = await axios.get(tokenUrl, {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    if (!response.data.access_token) {
      throw new Error('No access token received from M-Pesa');
    }

    console.log('✅ Access token generated successfully');
    console.log(`⏱️ Token expires in: ${response.data.expires_in} seconds`);
    return response.data.access_token;
    
  } catch (error) {
    console.error('❌ Token generation failed:');
    console.error('Status:', error.response?.status);
    console.error('Response:', error.response?.data);
    console.error('Message:', error.message);
    
    if (error.response?.status === 401) {
      throw new Error('Invalid M-Pesa credentials - check consumer key/secret');
    } else if (error.response?.status === 404) {
      throw new Error('M-Pesa endpoint not found - check URL');
    }
    
    throw new Error(`Token generation failed: ${error.message}`);
  }
}

// Utility: Generate M-Pesa password for STK Push
function generateMpesaPassword() {
  try {
    // Get current time in EAT (East Africa Time - UTC+3)
    const now = new Date();
    const eatTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    
    const timestamp = eatTime.getFullYear().toString() +
      ('0' + (eatTime.getMonth() + 1)).slice(-2) +
      ('0' + eatTime.getDate()).slice(-2) +
      ('0' + eatTime.getHours()).slice(-2) +
      ('0' + eatTime.getMinutes()).slice(-2) +
      ('0' + eatTime.getSeconds()).slice(-2);

    const password = Buffer.from(
      `${MPESA_CONFIG.business_short_code}${MPESA_CONFIG.passkey}${timestamp}`
    ).toString('base64');
    
    console.log('🔐 Generated M-Pesa password');
    console.log('🕐 Timestamp (EAT):', timestamp);
    
    return { password, timestamp };
  } catch (error) {
    console.error('❌ Password generation failed:', error);
    throw error;
  }
}

// Utility: Validate phone number
function validatePhoneNumber(phoneNumber) {
  if (!phoneNumber) {
    throw new Error('Phone number is required');
  }

  let cleanPhone = phoneNumber.toString().replace(/\D/g, '');
  
  // Convert to 254 format
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '254' + cleanPhone.substring(1);
  } else if (cleanPhone.startsWith('7') || cleanPhone.startsWith('1')) {
    cleanPhone = '254' + cleanPhone;
  }
  
  // Validate Kenyan phone number format
  if (!cleanPhone.match(/^254[71]\d{8}$/)) {
    throw new Error('Invalid Kenyan phone number. Use format: 0712345678 or 254712345678');
  }

  return cleanPhone;
}

// Utility: Validate amount
function validateAmount(amount) {
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount < 1 || numAmount > 70000) {
    throw new Error('Amount must be between 1 and 70,000 KES');
  }
  return Math.round(numAmount); // Round to nearest whole number
}

// Route: STK Push - Initiate payment
router.post('/mpesa/stk-push', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { 
      phone_number, 
      amount, 
      transaction_desc, 
      account_reference,
      user_id,
      photo_ids
    } = req.body;

    console.log('🚀 STK Push request initiated:', {
      phone: phone_number?.replace(/\d(?=\d{3})/g, '*'),
      amount,
      user_id: user_id?.substring(0, 8) + '...',
      photos_count: photo_ids?.length,
      timestamp: new Date().toISOString()
    });

    // Validate required fields
    if (!phone_number || !amount || !user_id || !photo_ids || !Array.isArray(photo_ids)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['phone_number', 'amount', 'user_id', 'photo_ids (array)']
      });
    }

    if (photo_ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one photo must be selected for purchase'
      });
    }

    // Validate phone number and amount
    const cleanPhone = validatePhoneNumber(phone_number);
    const validAmount = validateAmount(amount);

    console.log('✅ Validation passed:', { 
      phone: cleanPhone, 
      amount: validAmount,
      photos: photo_ids.length 
    });

    // Get M-Pesa access token
    let accessToken;
    try {
      accessToken = await getMpesaAccessToken();
    } catch (tokenError) {
      console.error('❌ Token generation failed:', tokenError.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to authenticate with M-Pesa',
        details: tokenError.message
      });
    }

    // Generate password and timestamp
    const { password, timestamp } = generateMpesaPassword();

    // Create unique transaction ID
    const transactionId = `SANDBOX_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    console.log('💾 Creating transaction record:', transactionId);
    
    // Create transaction record in database
    const { error: dbError } = await supabase
      .from('mpesa_transactions')
      .insert([{
        transaction_id: transactionId,
        user_id: user_id,
        phone_number: cleanPhone,
        amount: validAmount,
        photo_ids: photo_ids,
        status: 'initiated',
        created_at: new Date().toISOString()
      }]);

    if (dbError) {
      console.error('❌ Database error:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create transaction record',
        details: dbError.message
      });
    }

    // Prepare STK Push payload
    const stkPushData = {
      BusinessShortCode: parseInt(MPESA_CONFIG.business_short_code),
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: validAmount,
      PartyA: parseInt(cleanPhone),
      PartyB: parseInt(MPESA_CONFIG.business_short_code),
      PhoneNumber: parseInt(cleanPhone),
      CallBackURL: MPESA_CONFIG.callback_url,
      AccountReference: account_reference || transactionId,
      TransactionDesc: transaction_desc || `Photo Purchase - ${photo_ids.length} photo(s)`
    };

    console.log('📤 Sending STK Push to M-Pesa...', {
      amount: stkPushData.Amount,
      phone: stkPushData.PhoneNumber.toString().replace(/\d(?=\d{3})/g, '*'),
      reference: stkPushData.AccountReference
    });

    // Send STK Push request
    const stkResponse = await axios.post(
      `${MPESA_CONFIG.api_url}/mpesa/stkpush/v1/processrequest`,
      stkPushData,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    console.log('📨 STK Response received:', {
      ResponseCode: stkResponse.data.ResponseCode,
      ResponseDescription: stkResponse.data.ResponseDescription,
      CheckoutRequestID: stkResponse.data.CheckoutRequestID,
      processing_time: `${Date.now() - startTime}ms`
    });

    if (stkResponse.data.ResponseCode === '0') {
      // STK Push sent successfully
      const { error: updateError } = await supabase
        .from('mpesa_transactions')
        .update({
          checkout_request_id: stkResponse.data.CheckoutRequestID,
          merchant_request_id: stkResponse.data.MerchantRequestID,
          status: 'pending'
        })
        .eq('transaction_id', transactionId);

      if (updateError) {
        console.error('⚠️ Failed to update transaction with checkout details:', updateError);
      }

      console.log('🎉 STK Push sent successfully!');

      res.json({
        success: true,
        message: 'Payment request sent to your phone',
        data: {
          transaction_id: transactionId,
          checkout_request_id: stkResponse.data.CheckoutRequestID,
          customer_message: stkResponse.data.CustomerMessage || 'Check your phone for M-Pesa payment prompt',
          amount: validAmount,
          phone: cleanPhone.replace(/\d(?=\d{3})/g, '*'),
          photos_count: photo_ids.length
        }
      });

    } else {
      // STK Push failed
      await supabase
        .from('mpesa_transactions')
        .update({ 
          status: 'failed', 
          error_message: stkResponse.data.ResponseDescription
        })
        .eq('transaction_id', transactionId);

      console.log('❌ STK Push failed:', stkResponse.data.ResponseDescription);

      res.status(400).json({
        success: false,
        error: 'Payment request failed',
        message: stkResponse.data.ResponseDescription,
        code: stkResponse.data.ResponseCode
      });
    }

  } catch (error) {
    console.error('❌ STK Push error:', {
      message: error.message,
      response: error.response?.data,
      processing_time: `${Date.now() - startTime}ms`
    });
    
    let errorMessage = 'Failed to initiate payment';
    let statusCode = 500;

    if (error.message.includes('phone number')) {
      errorMessage = error.message;
      statusCode = 400;
    } else if (error.message.includes('Amount')) {
      errorMessage = error.message;
      statusCode = 400;
    } else if (error.response?.data?.errorMessage) {
      errorMessage = error.response.data.errorMessage;
    } else if (error.response?.data?.ResponseDescription) {
      errorMessage = error.response.data.ResponseDescription;
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Route: M-Pesa Callback Handler - Process payment results
router.post('/mpesa/callback', async (req, res) => {
  const callbackStartTime = Date.now();
  
  try {
    console.log('📞 M-Pesa Callback received at:', new Date().toISOString());
    console.log('📞 Callback data:', JSON.stringify(req.body, null, 2));

    const { Body } = req.body;
    const stkCallback = Body?.stkCallback;

    if (!stkCallback) {
      console.error('❌ Invalid callback structure - missing stkCallback');
      return res.json({ 
        ResultCode: 0, 
        ResultDesc: 'Invalid callback structure acknowledged' 
      });
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;

    console.log('🔍 Processing callback:', { 
      checkoutRequestId, 
      resultCode, 
      resultDesc,
      result_type: resultCode === 0 ? '✅ SUCCESS' : '❌ FAILED/CANCELLED'
    });

    // Find the transaction by checkout request ID
    const { data: transaction, error: fetchError } = await supabase
      .from('mpesa_transactions')
      .select('*')
      .eq('checkout_request_id', checkoutRequestId)
      .single();

    if (fetchError || !transaction) {
      console.error('❌ Transaction not found:', { checkoutRequestId, error: fetchError });
      return res.json({ 
        ResultCode: 0, 
        ResultDesc: 'Transaction not found but acknowledged' 
      });
    }

    console.log('📋 Found transaction:', {
      id: transaction.transaction_id,
      current_status: transaction.status,
      user_id: transaction.user_id,
      amount: transaction.amount,
      photos_count: transaction.photo_ids?.length || 0
    });

    // Prevent duplicate processing
    if (transaction.status === 'completed' || transaction.status === 'failed') {
      console.log('⚠️ Transaction already processed with status:', transaction.status);
      return res.json({ 
        ResultCode: 0, 
        ResultDesc: 'Transaction already processed' 
      });
    }

    // Process based on result code
    if (resultCode === 0) {
      // Payment successful
      console.log('🎉 Payment SUCCESS for transaction:', transaction.transaction_id);
      
      const callbackMetadata = stkCallback.CallbackMetadata?.Item || [];
      
      // Extract payment details from callback metadata
      const mpesaReceiptNumber = callbackMetadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const amountPaid = callbackMetadata.find(item => item.Name === 'Amount')?.Value;
      const transactionDate = callbackMetadata.find(item => item.Name === 'TransactionDate')?.Value;
      const balance = callbackMetadata.find(item => item.Name === 'Balance')?.Value;

      console.log('💰 Payment details:', {
        receipt: mpesaReceiptNumber,
        amount: amountPaid,
        date: transactionDate,
        balance: balance
      });

      // Update transaction to completed
      const { error: updateError } = await supabase
        .from('mpesa_transactions')
        .update({
          status: 'completed',
          mpesa_receipt_number: mpesaReceiptNumber,
          amount_paid: amountPaid,
          transaction_date: transactionDate?.toString(),
          callback_data: req.body,
          completed_at: new Date().toISOString()
        })
        .eq('transaction_id', transaction.transaction_id);

      if (updateError) {
        console.error('❌ Failed to update transaction to completed:', updateError);
        return res.json({ 
          ResultCode: 0, 
          ResultDesc: 'Database update failed but acknowledged' 
        });
      }

      console.log('✅ Transaction status updated to COMPLETED');

      // Process the photo payment
      try {
        const photoResult = await processPhotoPayment(transaction);
        console.log('✅ Photo payment processing completed:', photoResult);
      } catch (photoError) {
        console.error('❌ Photo payment processing failed:', photoError.message);
        // Don't fail the callback - the payment is still valid
        // Log the error for manual intervention if needed
        await supabase
          .from('mpesa_transactions')
          .update({
            error_message: `Photo processing failed: ${photoError.message}`
          })
          .eq('transaction_id', transaction.transaction_id);
      }

    } else {
      // Payment failed or cancelled
      const failureReasons = {
        1032: 'Request cancelled by user',
        1037: 'Timeout - user did not enter PIN',
        1001: 'Insufficient balance',
        2001: 'Wrong PIN entered',
        1: 'Generic failure'
      };

      const failureReason = failureReasons[resultCode] || 'Unknown failure';
      
      console.log('❌ Payment FAILED/CANCELLED:', {
        resultCode,
        reason: failureReason,
        description: resultDesc,
        transaction: transaction.transaction_id
      });
      
      const { error: updateError } = await supabase
        .from('mpesa_transactions')
        .update({
          status: 'failed',
          error_message: `${failureReason}: ${resultDesc}`,
          callback_data: req.body,
          completed_at: new Date().toISOString()
        })
        .eq('transaction_id', transaction.transaction_id);

      if (updateError) {
        console.error('❌ Failed to update transaction to failed:', updateError);
      } else {
        console.log('✅ Transaction status updated to FAILED');
      }
    }

    console.log(`⏱️ Callback processed in ${Date.now() - callbackStartTime}ms`);
    
    // Always acknowledge the callback successfully
    res.json({ 
      ResultCode: 0, 
      ResultDesc: 'Success' 
    });

  } catch (error) {
    console.error('❌ Callback processing error:', {
      message: error.message,
      stack: error.stack,
      processing_time: `${Date.now() - callbackStartTime}ms`
    });
    
    // Always acknowledge to prevent M-Pesa from retrying
    res.json({ 
      ResultCode: 0, 
      ResultDesc: 'Error occurred but callback acknowledged' 
    });
  }
});

// Process photo payment after successful M-Pesa transaction
async function processPhotoPayment(transaction) {
  try {
    const { photo_ids: imageIds, user_id: userId, transaction_id } = transaction;
    
    console.log('📸 Starting photo payment processing:', {
      transaction_id,
      user_id: userId,
      image_count: imageIds?.length || 0
    });

    if (!imageIds || !Array.isArray(imageIds) || imageIds.length === 0) {
      throw new Error('No image IDs provided for photo payment processing');
    }

    // Fetch and validate images
    const { data: images, error: fetchError } = await supabase
      .from('images')
      .select(`
        id,
        photo_collection_id,
        status,
        photos!inner(
          id,
          recipient_id,
          sender_id
        )
      `)
      .in('id', imageIds)
      .eq('photos.recipient_id', userId)
      .eq('status', 'unpaid');

    if (fetchError) {
      throw new Error(`Database error fetching images: ${fetchError.message}`);
    }

    if (!images || images.length === 0) {
      throw new Error(`No valid unpaid images found for user ${userId}`);
    }

    console.log(`📸 Found ${images.length} valid unpaid images`);

    // Update image statuses to 'paid'
    const imageIdsToUpdate = images.map(img => img.id);
    
    const { data: updatedImages, error: updateError } = await supabase
      .from('images')
      .update({ 
        status: 'paid',
        updated_at: new Date().toISOString()
      })
      .in('id', imageIdsToUpdate)
      .select('id, photo_collection_id');

    if (updateError) {
      throw new Error(`Failed to update image statuses: ${updateError.message}`);
    }

    if (!updatedImages || updatedImages.length === 0) {
      throw new Error('Critical error: No images were updated to paid status');
    }

    // Group results by photo collections
    const photoCollections = {};
    updatedImages.forEach(img => {
      photoCollections[img.photo_collection_id] = (photoCollections[img.photo_collection_id] || 0) + 1;
    });

    console.log('📸 Photo payment processing summary:', {
      user_id: userId,
      transaction_id,
      requested_images: imageIds.length,
      processed_images: updatedImages.length,
      collections_affected: Object.keys(photoCollections).length,
      collections: photoCollections
    });

    // Update photos table timestamps (optional)
    const uniqueCollectionIds = Object.keys(photoCollections);
    if (uniqueCollectionIds.length > 0) {
      await supabase
        .from('photos')
        .update({ updated_at: new Date().toISOString() })
        .in('id', uniqueCollectionIds);
    }

    return {
      success: true,
      processed_images: updatedImages.length,
      collections_affected: Object.keys(photoCollections).length,
      details: photoCollections
    };

  } catch (error) {
    console.error('❌ Photo payment processing failed:', error);
    throw error;
  }
}

// Route: Check transaction status
router.get('/mpesa/transaction/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    console.log('🔍 Checking transaction status:', transactionId);

    const { data: transaction, error } = await supabase
      .from('mpesa_transactions')
      .select('*')
      .eq('transaction_id', transactionId)
      .single();

    if (error || !transaction) {
      console.log('❌ Transaction not found:', transactionId);
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    const response = {
      success: true,
      transaction: {
        transaction_id: transaction.transaction_id,
        status: transaction.status,
        amount: transaction.amount,
        amount_paid: transaction.amount_paid,
        phone_number: transaction.phone_number,
        mpesa_receipt_number: transaction.mpesa_receipt_number,
        checkout_request_id: transaction.checkout_request_id,
        photo_ids: transaction.photo_ids,
        created_at: transaction.created_at,
        completed_at: transaction.completed_at,
        error_message: transaction.error_message
      }
    };

    console.log('✅ Transaction status:', transaction.status);
    res.json(response);

  } catch (error) {
    console.error('❌ Transaction query error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to query transaction'
    });
  }
});

// Route: Get user transactions (with authentication)
router.get('/transactions', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, status, sort = 'desc' } = req.query;

    console.log('📋 Fetching transactions for user:', userId.substring(0, 8) + '...');

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('mpesa_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: sort === 'asc' })
      .range(offset, offset + parseInt(limit) - 1);

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data: transactions, error } = await query;

    if (error) {
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch transactions'
      });
    }

    // Get total count for pagination
    let countQuery = supabase
      .from('mpesa_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (status && status !== 'all') {
      countQuery = countQuery.eq('status', status);
    }

    const { count, error: countError } = await countQuery;

    const totalPages = Math.ceil((count || 0) / parseInt(limit));

    res.json({
      success: true,
      data: {
        transactions: transactions || [],
        pagination: {
          current_page: parseInt(page),
          per_page: parseInt(limit),
          total_items: count || 0,
          total_pages: totalPages,
          has_next: parseInt(page) < totalPages,
          has_previous: parseInt(page) > 1
        }
      }
    });

  } catch (error) {
    console.error('❌ Get transactions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transactions'
    });
  }
});

// Route: Payment summary (with authentication)
router.get('/summary', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('📊 Generating payment summary for user:', userId.substring(0, 8) + '...');

    const { data: transactions, error } = await supabase
      .from('mpesa_transactions')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch payment summary'
      });
    }

    // Calculate statistics
    const completedTransactions = transactions.filter(t => t.status === 'completed');
    const pendingTransactions = transactions.filter(t => t.status === 'pending');
    const failedTransactions = transactions.filter(t => t.status === 'failed');

    const totalAmountPaid = completedTransactions.reduce((sum, t) => sum + (parseFloat(t.amount_paid) || parseFloat(t.amount) || 0), 0);
    const totalPhotoPurchased = completedTransactions.reduce((sum, t) => sum + (t.photo_ids?.length || 0), 0);

    const averageTransactionAmount = completedTransactions.length > 0 
      ? totalAmountPaid / completedTransactions.length 
      : 0;

    // Get latest transactions
    const recentTransactions = transactions
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5);

    const summary = {
      user_id: userId,
      overview: {
        total_transactions: transactions.length,
        completed_transactions: completedTransactions.length,
        pending_transactions: pendingTransactions.length,
        failed_transactions: failedTransactions.length
      },
      financial: {
        total_amount_paid: parseFloat(totalAmountPaid.toFixed(2)),
        average_transaction_amount: parseFloat(averageTransactionAmount.toFixed(2)),
        success_rate: transactions.length > 0 ? 
          parseFloat(((completedTransactions.length / transactions.length) * 100).toFixed(2)) : 0
      },
      activity: {
        total_photos_purchased: totalPhotoPurchased,
        last_transaction_date: recentTransactions[0]?.created_at || null,
        recent_transactions: recentTransactions.map(t => ({
          transaction_id: t.transaction_id,
          status: t.status,
          amount: t.amount,
          created_at: t.created_at,
          photos_count: t.photo_ids?.length || 0
        }))
      }
    };

    console.log('✅ Payment summary generated');
    res.json({
      success: true,
      summary
    });

  } catch (error) {
    console.error('❌ Get payment summary error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payment summary'
    });
  }
});

// Route: M-Pesa Validation endpoint (required by M-Pesa)
router.post('/mpesa/validation', (req, res) => {
  console.log('✅ M-Pesa Validation received:', {
    TransAmount: req.body.TransAmount,
    MSISDN: req.body.MSISDN,
    BillRefNumber: req.body.BillRefNumber,
    timestamp: new Date().toISOString()
  });
  
  res.json({ 
    ResultCode: 0, 
    ResultDesc: 'Validation successful' 
  });
});

// Route: M-Pesa Confirmation endpoint (required by M-Pesa)
router.post('/mpesa/confirmation', async (req, res) => {
  try {
    console.log('💰 M-Pesa Confirmation received:', {
      TransAmount: req.body.TransAmount,
      MSISDN: req.body.MSISDN,
      BillRefNumber: req.body.BillRefNumber,
      TransID: req.body.TransID,
      timestamp: new Date().toISOString()
    });

    // Optional: Log confirmation to database for audit trail
    const confirmationData = {
      trans_id: req.body.TransID,
      trans_amount: req.body.TransAmount,
      msisdn: req.body.MSISDN,
      bill_ref_number: req.body.BillRefNumber,
      trans_time: req.body.TransTime,
      business_short_code: req.body.BusinessShortCode,
      invoice_number: req.body.InvoiceNumber,
      org_account_balance: req.body.OrgAccountBalance,
      third_party_trans_id: req.body.ThirdPartyTransID,
      created_at: new Date().toISOString()
    };

    // You can store this in a separate confirmations table if needed
    console.log('📝 Confirmation details stored:', confirmationData.trans_id);
    
  } catch (error) {
    console.error('❌ Confirmation processing error:', error);
  }

  res.json({ 
    ResultCode: 0, 
    ResultDesc: 'Confirmation successful' 
  });
});

// Route: Test M-Pesa configuration
router.get('/test-config', async (req, res) => {
  try {
    console.log('🧪 Testing M-Pesa SANDBOX configuration...');
    
    const testResults = {
      mode: 'SANDBOX',
      environment: {
        oauth_url: MPESA_CONFIG.oauth_url,
        api_url: MPESA_CONFIG.api_url,
        business_short_code: MPESA_CONFIG.business_short_code,
        callback_url: MPESA_CONFIG.callback_url
      },
      credentials: {
        consumer_key_length: MPESA_CONFIG.consumer_key.length,
        consumer_secret_length: MPESA_CONFIG.consumer_secret.length,
        passkey_length: MPESA_CONFIG.passkey.length
      },
      timestamp: new Date().toISOString()
    };
    
    // Test access token generation
    try {
      const startTime = Date.now();
      const token = await getMpesaAccessToken();
      const tokenTime = Date.now() - startTime;
      
      testResults.token_test = {
        status: 'SUCCESS',
        response_time_ms: tokenTime,
        token_preview: token.substring(0, 20) + '...',
        token_length: token.length
      };
    } catch (tokenError) {
      testResults.token_test = {
        status: 'FAILED',
        error: tokenError.message,
        details: tokenError.response?.data || null
      };
    }
    
    // Test password generation
    try {
      const { password, timestamp } = generateMpesaPassword();
      testResults.password_test = {
        status: 'SUCCESS',
        timestamp: timestamp,
        password_length: password.length
      };
    } catch (passError) {
      testResults.password_test = {
        status: 'FAILED',
        error: passError.message
      };
    }

    // Test database connection
    try {
      const { error: dbError } = await supabase
        .from('mpesa_transactions')
        .select('count')
        .limit(1);
      
      testResults.database_test = {
        status: dbError ? 'FAILED' : 'SUCCESS',
        error: dbError?.message || null
      };
    } catch (dbTestError) {
      testResults.database_test = {
        status: 'FAILED',
        error: dbTestError.message
      };
    }
    
    const allTestsPassed = testResults.token_test.status === 'SUCCESS' && 
                          testResults.password_test.status === 'SUCCESS' &&
                          testResults.database_test.status === 'SUCCESS';
    
    res.json({
      success: allTestsPassed,
      message: allTestsPassed ? 
        '✅ All M-Pesa SANDBOX configurations are working correctly!' : 
        '❌ Some M-Pesa SANDBOX configurations have issues',
      test_results: testResults
    });
    
  } catch (error) {
    console.error('❌ Configuration test failed:', error);
    res.status(500).json({
      success: false,
      error: 'Configuration test failed',
      details: error.message
    });
  }
});

// Route: Health check
router.get('/health', async (req, res) => {
  try {
    const healthCheck = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'M-Pesa Payment Service',
      version: '1.0.0',
      environment: 'SANDBOX'
    };

    // Test database connection
    const { error } = await supabase
      .from('mpesa_transactions')
      .select('count')
      .limit(1);

    if (error) {
      healthCheck.status = 'unhealthy';
      healthCheck.database = 'disconnected';
      healthCheck.error = error.message;
    } else {
      healthCheck.database = 'connected';
    }

    const statusCode = healthCheck.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(healthCheck);

  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Route: Get system statistics (admin endpoint)
router.get('/admin/stats', async (req, res) => {
  try {
    console.log('📊 Generating system statistics...');

    // Get transaction statistics
    const { data: transactions, error } = await supabase
      .from('mpesa_transactions')
      .select('*');

    if (error) {
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch statistics'
      });
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Filter transactions by time periods
    const todayTransactions = transactions.filter(t => new Date(t.created_at) >= today);
    const weekTransactions = transactions.filter(t => new Date(t.created_at) >= thisWeek);
    const monthTransactions = transactions.filter(t => new Date(t.created_at) >= thisMonth);

    // Calculate statistics
    const completedTransactions = transactions.filter(t => t.status === 'completed');
    const totalRevenue = completedTransactions.reduce((sum, t) => sum + (parseFloat(t.amount_paid) || parseFloat(t.amount) || 0), 0);
    const totalPhotos = completedTransactions.reduce((sum, t) => sum + (t.photo_ids?.length || 0), 0);

    // Status distribution
    const statusCounts = {
      completed: transactions.filter(t => t.status === 'completed').length,
      pending: transactions.filter(t => t.status === 'pending').length,
      failed: transactions.filter(t => t.status === 'failed').length,
      initiated: transactions.filter(t => t.status === 'initiated').length
    };

    const statistics = {
      overview: {
        total_transactions: transactions.length,
        total_revenue: parseFloat(totalRevenue.toFixed(2)),
        total_photos_sold: totalPhotos,
        success_rate: transactions.length > 0 ? 
          parseFloat(((completedTransactions.length / transactions.length) * 100).toFixed(2)) : 0
      },
      time_periods: {
        today: {
          transactions: todayTransactions.length,
          revenue: parseFloat(todayTransactions
            .filter(t => t.status === 'completed')
            .reduce((sum, t) => sum + (parseFloat(t.amount_paid) || parseFloat(t.amount) || 0), 0)
            .toFixed(2))
        },
        this_week: {
          transactions: weekTransactions.length,
          revenue: parseFloat(weekTransactions
            .filter(t => t.status === 'completed')
            .reduce((sum, t) => sum + (parseFloat(t.amount_paid) || parseFloat(t.amount) || 0), 0)
            .toFixed(2))
        },
        this_month: {
          transactions: monthTransactions.length,
          revenue: parseFloat(monthTransactions
            .filter(t => t.status === 'completed')
            .reduce((sum, t) => sum + (parseFloat(t.amount_paid) || parseFloat(t.amount) || 0), 0)
            .toFixed(2))
        }
      },
      status_distribution: statusCounts,
      averages: {
        transaction_amount: completedTransactions.length > 0 ? 
          parseFloat((totalRevenue / completedTransactions.length).toFixed(2)) : 0,
        photos_per_transaction: completedTransactions.length > 0 ? 
          parseFloat((totalPhotos / completedTransactions.length).toFixed(2)) : 0
      },
      generated_at: new Date().toISOString()
    };

    console.log('✅ System statistics generated');
    res.json({
      success: true,
      statistics
    });

  } catch (error) {
    console.error('❌ Statistics generation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate statistics'
    });
  }
});

// Error handling middleware
router.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    timestamp: new Date().toISOString()
  });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// Export the router
module.exports = router;

console.log('🚀 M-Pesa Payment Server initialized successfully!');
console.log('📋 Available endpoints:');
console.log('  POST /mpesa/stk-push - Initiate payment');
console.log('  POST /mpesa/callback - Payment callback handler');
console.log('  GET  /mpesa/transaction/:id - Check transaction status');
console.log('  GET  /transactions - Get user transactions (auth required)');
console.log('  GET  /summary - Get payment summary (auth required)');
console.log('  GET  /test-config - Test M-Pesa configuration');
console.log('  GET  /health - Health check');
console.log('  GET  /admin/stats - System statistics');
console.log('✅ Server ready to process M-Pesa payments!');