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

// SANDBOX ONLY M-Pesa Configuration
const MPESA_CONFIG = {
  // SANDBOX credentials - these are safe to use for testing
  consumer_key: 'RKNVKZX9aQ1pkfAAA0gM0fadRoJH5ocEjNK0sQmyYB7qln6o', // Standard sandbox key
  consumer_secret: 'GcwX5AEGwJCvAYq2qDxr99Qh4lfiy6GhDKsoDuefRGLyhZotb7o1ckp0CZ548XBk', // Standard sandbox secret
  business_short_code: '174379', // Standard test shortcode
  passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919', // Standard test passkey
  
  // Callback URLs
  callback_url: process.env.MPESA_CALLBACK_URL || 'https://fine-back2.onrender.com/api/payments/mpesa/callback',
  confirmation_url: process.env.MPESA_CONFIRMATION_URL || 'https://fine-back2.onrender.com/api/payments/mpesa/confirmation',
  validation_url: process.env.MPESA_VALIDATION_URL || 'https://fine-back2.onrender.com/api/payments/mpesa/validation',
  
  // SANDBOX URLs ONLY - no production mixing
  oauth_url: 'https://sandbox.safaricom.co.ke',
  api_url: 'https://sandbox.safaricom.co.ke'
};

console.log('🧪 M-Pesa SANDBOX Mode Initialized');
console.log('OAuth URL:', MPESA_CONFIG.oauth_url);
console.log('API URL:', MPESA_CONFIG.api_url);
console.log('Business Short Code:', MPESA_CONFIG.business_short_code);

// Get M-Pesa access token - SANDBOX ONLY
async function getMpesaAccessToken() {
  try {
    // For sandbox, we use the standard credentials
    const credentials = Buffer.from(
      `${MPESA_CONFIG.consumer_key}:${MPESA_CONFIG.consumer_secret}`
    ).toString('base64');

    const tokenUrl = `${MPESA_CONFIG.oauth_url}/oauth/v1/generate?grant_type=client_credentials`;
    console.log('🔑 Getting SANDBOX access token from:', tokenUrl);

    const response = await axios.get(tokenUrl, {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    if (!response.data.access_token) {
      throw new Error('No access token received from sandbox');
    }

    console.log('✅ SANDBOX access token generated successfully');
    console.log('Token expires in:', response.data.expires_in, 'seconds');
    return response.data.access_token;
    
  } catch (error) {
    console.error('❌ SANDBOX token error:');
    console.error('Status:', error.response?.status);
    console.error('Response:', error.response?.data);
    console.error('Message:', error.message);
    
    if (error.response?.status === 401) {
      throw new Error('SANDBOX credentials invalid - check consumer key/secret');
    } else if (error.response?.status === 404) {
      throw new Error('SANDBOX endpoint not found - check URL');
    }
    
    throw new Error(`SANDBOX token failed: ${error.message}`);
  }
}

// Generate M-Pesa password for SANDBOX
function generateMpesaPassword() {
  // Use current timestamp in EAT (UTC+3)
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
  
  console.log('🔐 Generated SANDBOX password');
  console.log('Timestamp (EAT):', timestamp);
  console.log('Password length:', password.length);
  
  return { password, timestamp };
}

// SANDBOX STK Push
router.post('/mpesa/stk-push', async (req, res) => {
  try {
    const { 
      phone_number, 
      amount, 
      transaction_desc, 
      account_reference,
      user_id,
      photo_ids // Keep original parameter name
    } = req.body;

    console.log('📱 SANDBOX STK Push request:', {
      phone: phone_number?.replace(/\d(?=\d{3})/g, '*'),
      amount,
      user_id: user_id?.substring(0, 8) + '...',
      photos: photo_ids?.length,
      photo_ids: photo_ids // For debugging
    });

    // Validate required fields
    if (!phone_number || !amount || !user_id || !photo_ids || !Array.isArray(photo_ids)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: phone_number, amount, user_id, photo_ids (array)'
      });
    }

    // Clean and validate phone number for Kenya
    let cleanPhone = phone_number.replace(/\D/g, '');
    
    // Convert to 254 format
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '254' + cleanPhone.substring(1);
    } else if (cleanPhone.startsWith('7') || cleanPhone.startsWith('1')) {
      cleanPhone = '254' + cleanPhone;
    }
    
    // Validate final format (254 followed by 7 or 1, then 8 more digits)
    if (!cleanPhone.match(/^254[71]\d{8}$/)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Kenyan phone number. Use format: 0712345678 or 254712345678'
      });
    }

    // Validate amount
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount < 1 || numAmount > 70000) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be between 1 and 70,000 KES'
      });
    }

    console.log('✅ Validation passed. Phone:', cleanPhone, 'Amount:', numAmount);

    // Get SANDBOX access token
    let accessToken;
    try {
      accessToken = await getMpesaAccessToken();
    } catch (tokenError) {
      console.error('❌ SANDBOX token failed:', tokenError.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to authenticate with M-Pesa sandbox',
        details: tokenError.message
      });
    }

    // Generate password and timestamp
    const { password, timestamp } = generateMpesaPassword();

    // Create transaction record - CHANGED: Store photo_urls instead of photo_ids
    const transactionId = `SANDBOX_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    console.log('💾 Creating transaction record:', transactionId);
    
    const { error: dbError } = await supabase
      .from('mpesa_transactions')
      .insert([{
        transaction_id: transactionId,
        user_id: user_id,
        phone_number: cleanPhone,
        amount: numAmount,
        photo_ids: photo_ids, // Store the data as received from Flutter
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

    // Prepare STK Push data for SANDBOX
    const stkPushData = {
      BusinessShortCode: 174379,  // Fixed sandbox shortcode
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(numAmount),
      PartyA: parseInt(cleanPhone),
      PartyB: 174379,  // Same as business shortcode
      PhoneNumber: parseInt(cleanPhone),
      CallBackURL: MPESA_CONFIG.callback_url,
      AccountReference: account_reference || transactionId,
      TransactionDesc: transaction_desc || `Photo Purchase - ${photo_ids.length} photo(s)`
    };

    console.log('🚀 Sending SANDBOX STK Push...');
    console.log('Request data:', {
      ...stkPushData,
      Password: '***HIDDEN***',
      PhoneNumber: '***HIDDEN***'
    });

    // Send STK Push to SANDBOX
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

    console.log('📨 SANDBOX STK Response:', {
      ResponseCode: stkResponse.data.ResponseCode,
      ResponseDescription: stkResponse.data.ResponseDescription,
      CheckoutRequestID: stkResponse.data.CheckoutRequestID
    });

    if (stkResponse.data.ResponseCode === '0') {
      // Success - update transaction
      await supabase
        .from('mpesa_transactions')
        .update({
          checkout_request_id: stkResponse.data.CheckoutRequestID,
          merchant_request_id: stkResponse.data.MerchantRequestID,
          status: 'pending'
        })
        .eq('transaction_id', transactionId);

      console.log('✅ SANDBOX STK Push successful!');

      res.json({
        success: true,
        message: 'STK Push sent successfully to your phone',
        transaction_id: transactionId,
        checkout_request_id: stkResponse.data.CheckoutRequestID,
        customer_message: stkResponse.data.CustomerMessage || 'Check your phone for M-Pesa prompt'
      });
    } else {
      // Failed - update transaction
      await supabase
        .from('mpesa_transactions')
        .update({ 
          status: 'failed', 
          error_message: stkResponse.data.ResponseDescription
        })
        .eq('transaction_id', transactionId);

      console.log('❌ SANDBOX STK Push failed:', stkResponse.data.ResponseDescription);

      res.status(400).json({
        success: false,
        error: stkResponse.data.ResponseDescription || 'STK Push failed'
      });
    }

  } catch (error) {
    console.error('❌ SANDBOX STK Push error:', error.response?.data || error.message);
    
    let errorMessage = 'Failed to initiate payment';
    if (error.response?.data?.errorMessage) {
      errorMessage = error.response.data.errorMessage;
    } else if (error.response?.data?.ResponseDescription) {
      errorMessage = error.response.data.ResponseDescription;
    }
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// M-Pesa Callback Handler
router.post('/mpesa/callback', async (req, res) => {
  try {
    console.log('📞 SANDBOX Callback received:', JSON.stringify(req.body, null, 2));

    const { Body } = req.body;
    const stkCallback = Body?.stkCallback;

    if (!stkCallback) {
      console.error('Invalid callback structure');
      return res.json({ ResultCode: 0, ResultDesc: 'Invalid callback acknowledged' });
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;

    console.log('Processing callback:', { checkoutRequestId, resultCode, resultDesc });

    // Find the transaction
    const { data: transaction, error } = await supabase
      .from('mpesa_transactions')
      .select('*')
      .eq('checkout_request_id', checkoutRequestId)
      .single();

    if (error || !transaction) {
      console.error('Transaction not found:', checkoutRequestId);
      return res.json({ ResultCode: 0, ResultDesc: 'Transaction not found' });
    }

    if (resultCode === 0) {
      // Payment successful
      console.log('✅ SANDBOX Payment successful!');
      
      const callbackMetadata = stkCallback.CallbackMetadata?.Item || [];
      const mpesaReceiptNumber = callbackMetadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
      const amountPaid = callbackMetadata.find(item => item.Name === 'Amount')?.Value;
      const transactionDate = callbackMetadata.find(item => item.Name === 'TransactionDate')?.Value;

      // Update transaction to completed
      await supabase
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

      // Process the photo payment
      await processPhotoPayment(transaction);

    } else {
      // Payment failed
      console.log('❌ SANDBOX Payment failed:', resultDesc);
      
      await supabase
        .from('mpesa_transactions')
        .update({
          status: 'failed',
          error_message: resultDesc,
          callback_data: req.body,
          completed_at: new Date().toISOString()
        })
        .eq('transaction_id', transaction.transaction_id);
    }

    // Always acknowledge the callback
    res.json({ ResultCode: 0, ResultDesc: 'Success' });

  } catch (error) {
    console.error('Callback error:', error);
    res.json({ ResultCode: 0, ResultDesc: 'Callback processed' });
  }
});

// Validation endpoint
router.post('/mpesa/validation', (req, res) => {
  console.log('🔍 SANDBOX Validation:', req.body);
  res.json({ ResultCode: 0, ResultDesc: 'Validation successful' });
});

// Confirmation endpoint  
router.post('/mpesa/confirmation', (req, res) => {
  console.log('✅ SANDBOX Confirmation:', req.body);
  res.json({ ResultCode: 0, ResultDesc: 'Confirmation successful' });
});

// Transaction status check
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

// SANDBOX Test Configuration
router.get('/test-config', async (req, res) => {
  try {
    console.log('🧪 Testing SANDBOX configuration...');
    
    const testResults = {
      mode: 'SANDBOX',
      oauth_url: MPESA_CONFIG.oauth_url,
      api_url: MPESA_CONFIG.api_url,
      business_short_code: MPESA_CONFIG.business_short_code,
      callback_url: MPESA_CONFIG.callback_url
    };
    
    // Test token generation
    try {
      const token = await getMpesaAccessToken();
      testResults.token_test = 'SUCCESS';
      testResults.token_preview = token.substring(0, 20) + '...';
    } catch (tokenError) {
      testResults.token_test = 'FAILED';
      testResults.token_error = tokenError.message;
    }
    
    // Test password generation
    try {
      const { password, timestamp } = generateMpesaPassword();
      testResults.password_test = 'SUCCESS';
      testResults.timestamp = timestamp;
    } catch (passError) {
      testResults.password_test = 'FAILED';
      testResults.password_error = passError.message;
    }
    
    res.json({
      success: testResults.token_test === 'SUCCESS',
      message: testResults.token_test === 'SUCCESS' ? 
        'SANDBOX configuration is working correctly!' : 
        'SANDBOX configuration has issues',
      results: testResults
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Configuration test failed',
      details: error.message
    });
  }
});

// FIXED: Process photo payment helper - Now handles photo IDs properly
async function processPhotoPayment(transaction) {
  try {
    const photoIds = transaction.photo_ids; // Photo IDs from Flutter
    const userId = transaction.user_id;

    console.log(`🖼️ Processing photo payment for user ${userId}`);
    console.log(`🎯 Photo IDs received:`, photoIds);

    // Get user's photos
    const { data: photoRecord, error: fetchError } = await supabase
      .from('photos')
      .select('*')
      .eq('recipient_id', userId)
      .single();

    if (fetchError || !photoRecord) {
      console.error('Photo record not found:', userId, fetchError);
      return;
    }

    const unpaidImages = photoRecord.unpaid_images || [];
    const paidImages = photoRecord.paid_images || [];

    console.log(`📋 Current unpaid images count: ${unpaidImages.length}`);
    console.log(`📋 Current paid images count: ${paidImages.length}`);

    // Since your Flutter app selects specific photos but we only have URLs in the database,
    // we'll move the first N photos as requested (matching the count of selected photos)
    const numberOfImagesToBuy = photoIds.length;
    
    if (unpaidImages.length < numberOfImagesToBuy) {
      console.error(`❌ Not enough unpaid images. Available: ${unpaidImages.length}, Requested: ${numberOfImagesToBuy}`);
      return;
    }

    // Move the first N unpaid images to paid
    const imagesToMove = unpaidImages.slice(0, numberOfImagesToBuy);
    const remainingUnpaidImages = unpaidImages.slice(numberOfImagesToBuy);

    console.log(`✅ Moving ${imagesToMove.length} images to paid status`);

    // Add moved images to paid array as simple URLs
    const updatedPaidImages = [...paidImages, ...imagesToMove];

    // Update photos record
    const { error: updateError } = await supabase
      .from('photos')
      .update({
        unpaid_images: remainingUnpaidImages,
        paid_images: updatedPaidImages,
        updated_at: new Date().toISOString()
      })
      .eq('recipient_id', userId);

    if (updateError) {
      console.error('❌ Error updating photos:', updateError);
    } else {
      console.log(`✅ Successfully moved ${imagesToMove.length} images to paid status`);
      console.log(`📊 New counts - Paid: ${updatedPaidImages.length}, Unpaid: ${remainingUnpaidImages.length}`);
    }

  } catch (error) {
    console.error('❌ Photo payment processing error:', error);
  }
}

module.exports = router;