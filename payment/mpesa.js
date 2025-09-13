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

// M-Pesa Configuration
const MPESA_CONFIG = {
  consumer_key: 'RKNVKZX9aQ1pkfAAA0gM0fadRoJH5ocEjNK0sQmyYB7qln6o',
  consumer_secret: 'GcwX5AEGwJCvAYq2qDxr99Qh4lfiy6GhDKsoDuefRGLyhZotb7o1ckp0CZ548XBk',
  business_short_code: process.env.MPESA_BUSINESS_SHORT_CODE || '174379', // Use your actual business shortcode
  passkey: process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919', // Use your actual passkey
  callback_url: process.env.MPESA_CALLBACK_URL || 'https://your-app.com/api/payments/mpesa/callback',
  confirmation_url: process.env.MPESA_CONFIRMATION_URL || 'https://your-app.com/api/payments/mpesa/confirmation',
  validation_url: process.env.MPESA_VALIDATION_URL || 'https://your-app.com/api/payments/mpesa/validation',
  base_url: process.env.NODE_ENV === 'production' 
    ? 'https://api.safaricom.co.ke' 
    : 'https://sandbox.safaricom.co.ke'
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

// Initiate STK Push
router.post('/stk-push', async (req, res) => {
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
router.post('/callback', async (req, res) => {
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

// Query transaction status
router.get('/transaction/:transactionId', async (req, res) => {
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
router.post('/validation', (req, res) => {
  console.log('M-Pesa Validation:', req.body);
  res.json({
    ResultCode: 0,
    ResultDesc: 'Success'
  });
});

// Confirmation endpoint (required by Safaricom)
router.post('/confirmation', (req, res) => {
  console.log('M-Pesa Confirmation:', req.body);
  res.json({
    ResultCode: 0,
    ResultDesc: 'Success'
  });
});

module.exports = router;