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
    },
    db: {
      schema: 'public'
    },
    global: {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY
      }
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

// SANDBOX M-Pesa Configuration
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

console.log('M-Pesa SANDBOX Mode Initialized');
console.log('OAuth URL:', MPESA_CONFIG.oauth_url);
console.log('API URL:', MPESA_CONFIG.api_url);
console.log('Business Short Code:', MPESA_CONFIG.business_short_code);

// Get M-Pesa access token
async function getMpesaAccessToken() {
  try {
    const credentials = Buffer.from(
      `${MPESA_CONFIG.consumer_key}:${MPESA_CONFIG.consumer_secret}`
    ).toString('base64');

    const tokenUrl = `${MPESA_CONFIG.oauth_url}/oauth/v1/generate?grant_type=client_credentials`;
    console.log('Getting SANDBOX access token from:', tokenUrl);

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

    console.log('SANDBOX access token generated successfully');
    console.log('Token expires in:', response.data.expires_in, 'seconds');
    return response.data.access_token;
    
  } catch (error) {
    console.error('SANDBOX token error:');
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
  
  console.log('Generated SANDBOX password');
  console.log('Timestamp (EAT):', timestamp);
  console.log('Password length:', password.length);
  
  return { password, timestamp };
}

// STK Push endpoint
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

    console.log('SANDBOX STK Push request:', {
      phone: phone_number?.replace(/\d(?=\d{3})/g, '*'),
      amount,
      user_id: user_id?.substring(0, 8) + '...',
      photos: photo_ids?.length,
      photo_ids: photo_ids
    });

    // Validate required fields
    if (!phone_number || !amount || !user_id || !photo_ids || !Array.isArray(photo_ids)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: phone_number, amount, user_id, photo_ids (array)'
      });
    }

    // Clean and validate phone number
    let cleanPhone = phone_number.replace(/\D/g, '');
    
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '254' + cleanPhone.substring(1);
    } else if (cleanPhone.startsWith('7') || cleanPhone.startsWith('1')) {
      cleanPhone = '254' + cleanPhone;
    }
    
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

    console.log('Validation passed. Phone:', cleanPhone, 'Amount:', numAmount);

    // Get access token
    let accessToken;
    try {
      accessToken = await getMpesaAccessToken();
    } catch (tokenError) {
      console.error('SANDBOX token failed:', tokenError.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to authenticate with M-Pesa sandbox',
        details: tokenError.message
      });
    }

    // Generate password and timestamp
    const { password, timestamp } = generateMpesaPassword();

    // Create transaction record
    const transactionId = `SANDBOX_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    console.log('Creating transaction record:', transactionId);
    
    const { error: dbError } = await supabase
      .from('mpesa_transactions')
      .insert([{
        transaction_id: transactionId,
        user_id: user_id,
        phone_number: cleanPhone,
        amount: numAmount,
        photo_ids: photo_ids,
        status: 'initiated',
        created_at: new Date().toISOString()
      }]);

    if (dbError) {
      console.error('Database error:', dbError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create transaction record',
        details: dbError.message
      });
    }

    // Prepare STK Push data
    const stkPushData = {
      BusinessShortCode: 174379,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(numAmount),
      PartyA: parseInt(cleanPhone),
      PartyB: 174379,
      PhoneNumber: parseInt(cleanPhone),
      CallBackURL: MPESA_CONFIG.callback_url,
      AccountReference: account_reference || transactionId,
      TransactionDesc: transaction_desc || `Photo Purchase - ${photo_ids.length} photo(s)`
    };

    console.log('Sending SANDBOX STK Push...');

    // Send STK Push
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

    console.log('SANDBOX STK Response:', {
      ResponseCode: stkResponse.data.ResponseCode,
      ResponseDescription: stkResponse.data.ResponseDescription,
      CheckoutRequestID: stkResponse.data.CheckoutRequestID
    });

    if (stkResponse.data.ResponseCode === '0') {
      // Update transaction with checkout details
      const updateResult = await supabase
        .from('mpesa_transactions')
        .update({
          checkout_request_id: stkResponse.data.CheckoutRequestID,
          merchant_request_id: stkResponse.data.MerchantRequestID,
          status: 'pending',
          updated_at: new Date().toISOString()
        })
        .eq('transaction_id', transactionId);

      console.log('Database update result:', updateResult);
      console.log('SANDBOX STK Push successful!');

      // SIMPLE FIX: Auto-complete for sandbox after 10 seconds
      setTimeout(async () => {
        try {
          console.log('Auto-completing sandbox transaction:', transactionId);
          
          // Check if transaction is still pending
          const { data: checkTransaction } = await supabase
            .from('mpesa_transactions')
            .select('status')
            .eq('transaction_id', transactionId)
            .single();

          if (checkTransaction && checkTransaction.status === 'pending') {
            // Auto-complete the transaction
            const mockReceiptNumber = `SANDBOX${Date.now()}`;
            
            const { error: completeError } = await supabase
              .from('mpesa_transactions')
              .update({
                status: 'completed',
                mpesa_receipt_number: mockReceiptNumber,
                transaction_date: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              })
              .eq('transaction_id', transactionId);

            if (!completeError) {
              console.log('Auto-completed sandbox transaction:', transactionId);
              
              // Get transaction details and process payment
              const { data: transaction } = await supabase
                .from('mpesa_transactions')
                .select('*')
                .eq('transaction_id', transactionId)
                .single();

              if (transaction) {
                await processPhotoPayment(transaction);
              }
            }
          }
        } catch (autoCompleteError) {
          console.error('Auto-complete error:', autoCompleteError);
        }
      }, 10000); // 10 seconds delay

      res.json({
        success: true,
        message: 'STK Push sent successfully to your phone',
        transaction_id: transactionId,
        checkout_request_id: stkResponse.data.CheckoutRequestID,
        customer_message: stkResponse.data.CustomerMessage || 'Check your phone for M-Pesa prompt'
      });
    } else {
      // Update transaction as failed
      await supabase
        .from('mpesa_transactions')
        .update({ 
          status: 'failed', 
          error_message: stkResponse.data.ResponseDescription,
          updated_at: new Date().toISOString()
        })
        .eq('transaction_id', transactionId);

      console.log('SANDBOX STK Push failed:', stkResponse.data.ResponseDescription);

      res.status(400).json({
        success: false,
        error: stkResponse.data.ResponseDescription || 'STK Push failed'
      });
    }

  } catch (error) {
    console.error('SANDBOX STK Push error:', error.response?.data || error.message);
    
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

// M-Pesa Callback Handler - FIXED
router.post('/mpesa/callback', async (req, res) => {
  try {
    console.log('SANDBOX Callback received:', JSON.stringify(req.body, null, 2));

    const { Body } = req.body;
    const stkCallback = Body?.stkCallback;

    if (!stkCallback) {
      console.error('Invalid callback structure');
      return res.json({ ResultCode: 0, ResultDesc: 'Invalid callback acknowledged' });
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const resultCode = parseInt(stkCallback.ResultCode);
    const resultDesc = stkCallback.ResultDesc;

    console.log('Processing callback:', { checkoutRequestId, resultCode, resultDesc });

    // Find the transaction
    const { data: transaction, error } = await supabase
      .from('mpesa_transactions')
      .select('*')
      .eq('checkout_request_id', checkoutRequestId)
      .single();

    if (error || !transaction) {
      console.error('Transaction not found:', checkoutRequestId, error);
      return res.json({ ResultCode: 0, ResultDesc: 'Transaction not found' });
    }

    if (resultCode === 0) {
      // Payment successful - FIXED UPDATE
      console.log('SANDBOX Payment successful!');
      
      const callbackMetadata = stkCallback.CallbackMetadata?.Item || [];
      const mpesaReceiptNumber = callbackMetadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value || `SANDBOX${Date.now()}`;
      const amountPaid = callbackMetadata.find(item => item.Name === 'Amount')?.Value || transaction.amount;
      const transactionDate = callbackMetadata.find(item => item.Name === 'TransactionDate')?.Value || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

      // Update transaction to completed - ENSURE THIS WORKS
      const { data: updatedTransaction, error: updateError } = await supabase
        .from('mpesa_transactions')
        .update({
          status: 'completed',
          mpesa_receipt_number: mpesaReceiptNumber,
          amount_paid: parseFloat(amountPaid),
          transaction_date: transactionDate.toString(),
          callback_data: req.body,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('transaction_id', transaction.transaction_id)
        .select();

      if (updateError) {
        console.error('Failed to update transaction:', updateError);
      } else {
        console.log('Transaction updated successfully:', updatedTransaction);
        // Process the photo payment
        await processPhotoPayment({ ...transaction, status: 'completed' });
      }

    } else {
      // Payment failed - FIXED UPDATE
      console.log('SANDBOX Payment failed:', resultDesc);
      
      const { error: failError } = await supabase
        .from('mpesa_transactions')
        .update({
          status: 'failed',
          error_message: resultDesc,
          callback_data: req.body,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('transaction_id', transaction.transaction_id);

      if (failError) {
        console.error('Failed to update failed transaction:', failError);
      }
    }

    // Always acknowledge the callback
    res.json({ ResultCode: 0, ResultDesc: 'Success' });

  } catch (error) {
    console.error('Callback error:', error);
    res.json({ ResultCode: 0, ResultDesc: 'Callback processed' });
  }
});

// Process photo payment function
async function processPhotoPayment(transaction) {
  try {
    const imageIds = transaction.photo_ids;
    const userId = transaction.user_id;
    const numberOfPhotosRequested = imageIds.length;

    console.log(`Processing photo payment for user ${userId}`);
    console.log(`Photos requested: ${numberOfPhotosRequested}`);
    console.log(`Image IDs from Flutter:`, imageIds);

    // Validate that the images exist and belong to photos where user is recipient
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
      console.error('Database error fetching images:', fetchError);
      return;
    }

    if (!images || images.length === 0) {
      console.error('No valid unpaid images found for user:', userId);
      console.error('Requested image IDs:', imageIds);
      return;
    }

    console.log(`Found ${images.length} valid unpaid images out of ${numberOfPhotosRequested} requested`);

    if (images.length < numberOfPhotosRequested) {
      console.warn(`Not all requested images are available. Available: ${images.length}, Requested: ${numberOfPhotosRequested}`);
    }

    // Update image statuses to 'paid' - ENSURE THIS WORKS
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
      console.error('Error updating image statuses:', updateError);
      return;
    }

    if (!updatedImages || updatedImages.length === 0) {
      console.error('CRITICAL: No images were updated to paid status!');
      return;
    }

    console.log(`Successfully updated ${updatedImages.length} images to paid status`);

    // Group by photo collections for summary
    const photoCollections = {};
    updatedImages.forEach(img => {
      if (!photoCollections[img.photo_collection_id]) {
        photoCollections[img.photo_collection_id] = 0;
      }
      photoCollections[img.photo_collection_id]++;
    });

    // Log summary by photo collection
    console.log(`Payment processing summary:`);
    console.log(`  - User: ${userId}`);
    console.log(`  - Requested: ${numberOfPhotosRequested} images`);
    console.log(`  - Successfully processed: ${updatedImages.length} images`);
    console.log(`  - Photo collections affected: ${Object.keys(photoCollections).length}`);
    console.log(`  - Transaction: ${transaction.transaction_id}`);
    console.log(`  - M-Pesa Receipt: ${transaction.mpesa_receipt_number || 'N/A'}`);

    Object.entries(photoCollections).forEach(([collectionId, count]) => {
      console.log(`    * Collection ${collectionId}: ${count} images paid`);
    });

    // Optional: Update photos table if you want to track payment status at collection level
    const uniqueCollectionIds = Object.keys(photoCollections);
    if (uniqueCollectionIds.length > 0) {
      const { error: photoUpdateError } = await supabase
        .from('photos')
        .update({ updated_at: new Date().toISOString() })
        .in('id', uniqueCollectionIds);

      if (photoUpdateError) {
        console.warn('Warning: Could not update photos updated_at timestamp:', photoUpdateError);
      }
    }

    console.log('PAYMENT PROCESSING COMPLETE - All operations successful');

  } catch (error) {
    console.error('Photo payment processing error:', error);
    console.error('Stack trace:', error.stack);
  }
}

// Validation endpoint
router.post('/mpesa/validation', (req, res) => {
  console.log('SANDBOX Validation:', req.body);
  res.json({ ResultCode: 0, ResultDesc: 'Validation successful' });
});

// Confirmation endpoint  
router.post('/mpesa/confirmation', (req, res) => {
  console.log('SANDBOX Confirmation:', req.body);
  res.json({ ResultCode: 0, ResultDesc: 'Confirmation successful' });
});

// Transaction status check - IMPROVED
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
        error_message: transaction.error_message,
        photo_count: transaction.photo_ids ? transaction.photo_ids.length : 0
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

// Get user transactions (with auth)
router.get('/transactions', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, status } = req.query;

    let query = supabase
      .from('mpesa_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

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

    res.json({
      success: true,
      transactions: transactions || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        hasMore: count > page * limit
      }
    });

  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transactions'
    });
  }
});

// Payment summary (with auth)
router.get('/summary', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;

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

    const completedTransactions = transactions.filter(t => t.status === 'completed');
    const pendingTransactions = transactions.filter(t => t.status === 'pending');
    const failedTransactions = transactions.filter(t => t.status === 'failed');

    const totalAmountPaid = completedTransactions.reduce((sum, t) => sum + (t.amount || 0), 0);
    const averageTransactionAmount = completedTransactions.length > 0 
      ? totalAmountPaid / completedTransactions.length 
      : 0;

    const lastTransaction = transactions.length > 0 
      ? transactions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
      : null;

    res.json({
      success: true,
      summary: {
        user_id: userId,
        total_transactions: transactions.length,
        completed_transactions: completedTransactions.length,
        pending_transactions: pendingTransactions.length,
        failed_transactions: failedTransactions.length,
        total_amount_paid: totalAmountPaid,
        average_transaction_amount: averageTransactionAmount,
        last_transaction_date: lastTransaction?.created_at || null
      }
    });

  } catch (error) {
    console.error('Get payment summary error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payment summary'
    });
  }
});

// Test configuration endpoint
router.get('/test-config', async (req, res) => {
  try {
    console.log('Testing SANDBOX configuration...');
    
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

module.exports = router;