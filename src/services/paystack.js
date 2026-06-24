/**
 * Paystack Payment Service — AirCommit
 *
 * Handles checkout session creation and webhook verification.
 * Uses the Classic Checkout API (redirect-based) since Telegram
 * bots can't use inline Paystack elements.
 *
 * API Docs: https://paystack.com/docs/api/#checkout
 */

import crypto from 'crypto';
import logger from '../core/logger.js';
import { SUBSCRIPTION_TIERS } from '../services/subscription.js';

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET;

if (!PAYSTACK_SECRET_KEY) {
    logger.warn({ component: 'paystack' }, 'PAYSTACK_SECRET_KEY not set — Paystack payments disabled');
}

/**
 * Create a Paystack checkout session.
 * Returns { url, accessCode } for the user to complete payment.
 */
export async function createCheckoutSession(chatId, tier, email, amountNGN) {
    if (!PAYSTACK_SECRET_KEY) {
        throw new Error('Paystack is not configured (missing PAYSTACK_SECRET_KEY)');
    }

    const tierConfig = SUBSCRIPTION_TIERS[tier];
    if (!tierConfig) {
        throw new Error(`Invalid tier: ${tier}`);
    }

    // Paystack amounts are in kobo (1 NGN = 100 kobo)
    const amountKobo = amountNGN * 100;
    const reference = `aircommit_${tier}_${chatId}_${Date.now()}`;

    try {
        const response = await fetch(`${PAYSTACK_BASE_URL}/transaction`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                email: email || `user${chatId}@aircommit.app`,
                amount: amountKobo,
                reference: reference,
                metadata: {
                    chat_id: chatId,
                    tier: tier,
                    source: 'telegram',
                },
                // Callback URL is optional — we rely on webhook
                currency: 'NGN',
            }),
        });

        const data = await response.json();

        if (!data.status || !data.data?.access_code) {
            throw new Error(data.message || 'Failed to create Paystack transaction');
        }

        const checkoutUrl = `https://paystack.com/pay/${data.data.access_code}`;

        logger.info({
            component: 'paystack',
            reference,
            chatId,
            tier,
            amount: amountNGN,
        }, 'Paystack checkout session created');

        return {
            url: checkoutUrl,
            accessCode: data.data.access_code,
            reference,
        };
    } catch (error) {
        logger.error({ component: 'paystack', error: error.message }, 'Paystack checkout creation failed');
        throw error;
    }
}

/**
 * Verify a Paystack transaction by reference.
 * Returns true if the transaction is successful.
 */
export async function verifyTransaction(reference) {
    if (!PAYSTACK_SECRET_KEY) return false;

    try {
        const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/verify/${reference}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
            },
        });

        const data = await response.json();

        if (!data.status) {
            logger.warn({ component: 'paystack', reference }, 'Transaction verify failed');
            return false;
        }

        const status = data.data.status;
        return status === 'success';
    } catch (error) {
        logger.error({ component: 'paystack', error: error.message }, 'Transaction verification failed');
        return false;
    }
}

/**
 * Verify a Paystack webhook signature using HMAC-SHA256.
 * Returns true if the signature is valid.
 */
export function verifyWebhookSignature(rawBody, signature) {
    if (!PAYSTACK_WEBHOOK_SECRET) {
        // Skip verification in development if no webhook secret set
        logger.warn({ component: 'paystack' }, 'PAYSTACK_WEBHOOK_SECRET not set — webhook signature verification disabled');
        return true;
    }

    try {
        const hmac = crypto.createHmac('sha512', PAYSTACK_WEBHOOK_SECRET);
        const digest = hmac.update(rawBody).digest('hex');
        return digest === signature;
    } catch (error) {
        logger.error({ component: 'paystack', error: error.message }, 'Webhook signature verification failed');
        return false;
    }
}

export default {
    createCheckoutSession,
    verifyTransaction,
    verifyWebhookSignature,
};
