/**
 * Payment Commands — AirCommit
 *
 * Primary payment method: Paystack (card, bank transfer, USSD).
 * Fallback: manual bank transfer (admin-activated).
 *
 * Flow:
 * 1. /upgrade → show tiers → user picks → Paystack checkout URL
 * 2. User pays on Paystack → webhook fires → auto-activate
 * 3. Bank fallback → user sends proof → admin activates manually
 */

import { saveUserSession, getUserSession } from '../services/supabase.js';
import { SUBSCRIPTION_TIERS, PAYMENT_METHODS, activateSubscription, getSubscriptionTier } from '../services/subscription.js';
import { createCheckoutSession, verifyTransaction } from '../services/paystack.js';
import logger from '../core/logger.js';

// In-memory store for pending payments (use Redis in production)
const pendingPayments = new Map();

// ─── Admin Setup ─────────────────────────────────────────────────────────────

function getAdminChatIds() {
    const adminsRaw = process.env.ADMIN_CHAT_IDS || '';
    if (!adminsRaw) return [];
    return adminsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

function isAdmin(chatId) {
    return getAdminChatIds().includes(chatId);
}

// ─── /upgrade Command ────────────────────────────────────────────────────────

export function registerPaymentCommands(bot) {
    // /upgrade — show pricing and create Paystack checkout
    bot.onText(/^\/upgrade$/, async (msg) => {
        const chatId = msg.chat.id;
        const session = await getUserSession(chatId);
        const currentTier = getSubscriptionTier(session);

        if (currentTier !== 'free') {
            const tierConfig = SUBSCRIPTION_TIERS[currentTier];
            return bot.sendMessage(chatId,
                `✅ You are already on the *${tierConfig.name}* plan.\n\n` +
                'Use `/status` to see your plan details.'
            );
        }

        // Build inline keyboard for tier selection
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📦 Starter — ₦5,000/mo', callback_data: 'pay_starter' },
                ],
                [
                    { text: '🚀 Pro — ₦15,000/mo', callback_data: 'pay_pro' },
                ],
                [
                    { text: '👥 Team — ₦30,000/mo', callback_data: 'pay_team' },
                ],
            ],
        };

        bot.sendMessage(chatId,
            `💎 *AirCommit Premium*\n\n` +
            `Take on more clients. Handle their requests and build features — even when you're not at your desk.\n\n` +
            `📦 *Starter* — ₦5,000/mo\n` +
            `   • 50 commands/month\n` +
            `   • Smart code suggestions\n\n` +
            `🚀 *Pro* — ₦15,000/mo\n` +
            `   • 200 commands/month\n` +
            `   • AI code fixes, compile & run\n` +
            `   • Code editor, PR reviews\n\n` +
            `👥 *Team* — ₦30,000/mo\n` +
            `   • Unlimited commands\n` +
            `   • Multi-repo, team AI memory\n\n` +
            `💳 Pay with Paystack (card, bank, USSD):`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    });

    // Handle callback queries (tier selection + cancel/keep)
    bot.on('callback_query', async (callbackQuery) => {
        const chatId = callbackQuery.message?.chat?.id;
        if (!chatId) return;

        const data = callbackQuery.data;
        const msgId = callbackQuery.message?.message_id;

        if (!data || !msgId) return;
        bot.answerCallbackQuery({ callback_query_id: callbackQuery.id });

        // ── Paystack checkout initiation ──────────────────────────────────
        if (data === 'pay_starter' || data === 'pay_pro' || data === 'pay_team') {
            const tier = data.replace('pay_', '');
            const tierConfig = SUBSCRIPTION_TIERS[tier];

            try {
                const session = await getUserSession(chatId);
                const email = session?.email || `user${chatId}@aircommit.app`;

                const checkout = await createCheckoutSession(chatId, tier, email, tierConfig.priceNGN);

                // Store pending payment for webhook tracking
                pendingPayments.set(checkout.reference, {
                    chatId,
                    tier,
                    created: Date.now(),
                });

                // Send checkout button to user
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: `💳 Pay ₦${tierConfig.priceNGN.toLocaleString()} with Paystack`, type: 'url', url: checkout.url },
                        ],
                    ],
                };

                bot.editMessageText(
                    `⏳ *${tierConfig.name} Plan*\n\n` +
                    `Click below to pay securely with Paystack:\n` +
                    `(Card, Bank Transfer, or USSD)\n\n` +
                    `*Amount:* ₦${tierConfig.priceNGN.toLocaleString()}/month\n\n` +
                    `Use bank transfer below as an alternative.`,
                    { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: keyboard }
                );
            } catch (error) {
                logger.error({ component: 'payment', error: error.message }, 'Paystack checkout creation failed');
                bot.editMessageText(
                    `❌ Failed to create payment link. Please try again.\n\n` +
                    `Or use bank transfer with \`/pay\`.`,
                    { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
                );
            }
            return;
        }

        // ── Bank transfer fallback ──────────────────────────────────────────
        if (data === 'pay_bank' && PAYMENT_METHODS.bank.enabled) {
            bot.editMessageText(
                `🏦 *Bank Transfer Payment*\n\n` +
                `Send payment to:\n\n` +
                `🏦 **Bank:** ${PAYMENT_METHODS.bank.details.bank}\n` +
                `🔢 **Account:** ${PAYMENT_METHODS.bank.details.account_number}\n` +
                `👤 **Name:** ${PAYMENT_METHODS.bank.details.account_name}\n\n` +
                `*Amounts:*\n` +
                `• Starter: ₦5,000/month\n` +
                `• Pro: ₦15,000/month\n` +
                `• Team: ₦30,000/month\n\n` +
                `After payment, *reply to this message* with:\n` +
                `• Amount sent\n` +
                `• Phone number used\n\n` +
                `We'll activate within 5 minutes.`,
                { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
            );
            return;
        }

        // ── Cancel/keep subscription ──────────────────────────────────────
        if (data === 'cancel_sub' || data === 'keep_sub') {
            const session = await getUserSession(chatId);
            const tier = getSubscriptionTier(session);

            if (tier === 'free') {
                bot.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'No active subscription' });
                return;
            }

            if (data === 'cancel_sub') {
                await saveUserSession(chatId, {
                    subscription_cancelled_at: new Date().toISOString(),
                });

                bot.answerCallbackQuery({
                    callback_query_id: callbackQuery.id,
                    text: 'Subscription cancelled. Active until expiry.',
                });

                bot.editMessageText(
                    `✅ Subscription cancelled.\n\n` +
                    `Your plan remains active until the end of your billing period.`,
                    { chat_id: chatId, message_id: msgId }
                );
            }

            if (data === 'keep_sub') {
                bot.answerCallbackQuery({
                    callback_query_id: callbackQuery.id,
                    text: 'Subscription kept active!',
                });
                bot.editMessageText(
                    `✅ Subscription kept active. Enjoy!\n\n` +
                    `Use \`/status\` to see your plan details.`,
                    { chat_id: chatId, message_id: msgId }
                );
            }
            return;
        }
    });

    // /pay — show payment options (alias for /upgrade)
    bot.onText(/^\/pay$/, async (msg) => {
        // Just redirect to /upgrade flow
        bot.executeCommand('/upgrade', msg);
    });

    // Handle manual payment proof replies (bank/crypto)
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;
        if (!text || !msg.reply_to_message) return;

        const replyTo = msg.reply_to_message;
        if (!replyTo || !replyTo.text) return;

        const originalText = replyTo.text;
        const isBankReply = originalText.includes('Bank Transfer');
        const isCryptoReply = originalText.includes('Crypto Payment');

        if (isBankReply || isCryptoReply) {
            const parts = text.split(/\s+/);
            if (parts.length < 2) {
                bot.sendMessage(chatId,
                    `Please reply with your payment details:\n` +
                    `• Amount sent (e.g., 15000)\n` +
                    `• Phone number or transaction hash\n\n` +
                    `Example: \`15000 0801234567\``
                );
                return;
            }

            const amount = parts[0];
            const proof = parts.slice(1).join(' ');
            const paymentMethod = isBankReply ? 'bank' : 'crypto';

            // Forward to admin for manual activation
            const adminIds = getAdminChatIds();
            let adminNotify = `📩 *New Payment Proof*\n\n`;
            adminNotify += `👤 Chat ID: \`${chatId}\`\n`;
            adminNotify += `💰 Amount: ₦${parseInt(amount).toLocaleString()}\n`;
            adminNotify += `🔑 Proof: \`${proof}\`\n`;
            adminNotify += `💳 Method: ${paymentMethod}\n`;
            adminNotify += `⏰ ${new Date().toISOString()}`;

            for (const adminId of adminIds) {
                try {
                    const activateKeyboard = {
                        inline_keyboard: [
                            [
                                { text: '✅ Starter (₦5K)', callback_data: `admin_activate_starter_${chatId}` },
                                { text: '✅ Pro (₦15K)', callback_data: `admin_activate_pro_${chatId}` },
                                { text: '✅ Team (₦30K)', callback_data: `admin_activate_team_${chatId}` },
                            ],
                            [
                                { text: '❌ Reject', callback_data: `admin_reject_${chatId}` },
                            ],
                        ],
                    };
                    bot.sendMessage(adminId, adminNotify, {
                        parse_mode: 'Markdown',
                        reply_markup: activateKeyboard,
                    });
                } catch (err) {
                    logger.error({ component: 'payment', error: err.message }, 'Admin notification failed');
                }
            }

            bot.sendMessage(chatId,
                `✅ Payment proof received!\n\n` +
                `Our team will review and activate your account within 5-10 minutes.\n\n` +
                `Use \`/status\` to check your subscription.`
            );
        }
    });

    // Handle admin activation/reject callbacks
    bot.on('callback_query', async (callbackQuery) => {
        const data = callbackQuery.data;
        if (!data) return;

        // Admin activate: admin_activate_<tier>_<chatId>
        const adminActivateMatch = data.match(/^admin_activate_(starter|pro|team)_(\d+)$/);
        if (adminActivateMatch) {
            const tier = adminActivateMatch[1];
            const userChatId = parseInt(adminActivateMatch[2], 10);
            const adminChatId = callbackQuery.message?.chat?.id;

            if (!isAdmin(adminChatId)) {
                bot.answerCallbackQuery({
                    callback_query_id: callbackQuery.id,
                    text: 'Only admins can do this',
                    show_alert: true,
                });
                return;
            }

            try {
                const subscriptionData = await activateSubscription(userChatId, tier, 30, 'manual');
                await saveUserSession(userChatId, subscriptionData);

                bot.answerCallbackQuery({
                    callback_query_id: callbackQuery.id,
                    text: `Activated ${tier} for user`,
                });

                bot.sendMessage(adminChatId,
                    `✅ Activated *${tier}* for chat \`${userChatId}\`.\n` +
                    `Expires: ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}`
                );

                bot.sendMessage(userChatId,
                    `🎉 *${tier.charAt(0).toUpperCase() + tier.slice(1)} Activated!*\n\n` +
                    `Your AirCommit ${tier.charAt(0).toUpperCase() + tier.slice(1)} plan is now active for 30 days.\n\n` +
                    `Use \`/status\` to see your features.`
                );
            } catch (error) {
                bot.answerCallbackQuery({
                    callback_query_id: callbackQuery.id,
                    text: `Error: ${error.message}`,
                    show_alert: true,
                });
            }
            return;
        }

        // Admin reject: admin_reject_<chatId>
        const adminRejectMatch = data.match(/^admin_reject_(\d+)$/);
        if (adminRejectMatch) {
            const userChatId = parseInt(adminRejectMatch[1], 10);
            const adminChatId = callbackQuery.message?.chat?.id;

            if (!isAdmin(adminChatId)) return;

            bot.answerCallbackQuery({
                callback_query_id: callbackQuery.id,
                text: 'Rejected',
            });

            bot.sendMessage(userChatId,
                `❌ Your payment was not approved.\n\n` +
                `Please contact support if you believe this is an error.\n\n` +
                `Use \`/pay\` to try again.`
            );
        }
    });

    // /status — show current subscription
    bot.onText(/^\/status$/, async (msg) => {
        const chatId = msg.chat.id;
        const session = await getUserSession(chatId);
        const tier = getSubscriptionTier(session);
        const tierConfig = SUBSCRIPTION_TIERS[tier];

        let message = `📊 *AirCommit Status*\n\n`;
        message += `🔹 Plan: *${tierConfig.name}*\n`;

        if (tier === 'free') {
            message += `\nFree plan — upgrade with \`/upgrade\` for premium features!\n\n`;
        } else {
            const expiresAt = session?.subscription_expires_at;
            if (expiresAt) {
                const expiry = new Date(expiresAt);
                const daysLeft = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
                message += `📅 Expires: ${expiry.toLocaleDateString()} (${daysLeft} days left)\n`;
            }
            const source = session?.subscription_source;
            if (source) {
                message += `💳 Paid via: ${source}\n`;
            }
        }

        message += `\n📋 *Features:*\n`;
        message += `• Commands: ${tierConfig.commandsPerDay < 0 ? 'Unlimited' : tierConfig.commandsPerDay + '/month'}\n`;
        message += `• Repos: ${tierConfig.maxRepos < 0 ? 'Unlimited' : tierConfig.maxRepos}\n`;
        message += `• History: ${tierConfig.historyDays < 0 ? 'Unlimited' : tierConfig.historyDays + ' days'}\n`;

        if (tier !== 'free') {
            message += `\nUse \`/cancel\` to manage your subscription.`;
        }

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    // /cancel — cancel subscription
    bot.onText(/^\/cancel$/, async (msg) => {
        const chatId = msg.chat.id;
        const session = await getUserSession(chatId);
        const tier = getSubscriptionTier(session);

        if (tier === 'free') {
            return bot.sendMessage(chatId, `You are on the free plan — nothing to cancel.`);
        }

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '❌ Cancel Subscription', callback_data: 'cancel_sub' },
                ],
                [
                    { text: 'Keep It', callback_data: 'keep_sub' },
                ],
            ],
        };

        bot.sendMessage(chatId,
            `⚠️ *Cancel Subscription?*\n\n` +
            `Your subscription will remain active until the end of the billing period.\n\n` +
            `After that, you'll be downgraded to the free plan.`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    });

    // /billing — view billing info
    bot.onText(/^\/billing$/, async (msg) => {
        const chatId = msg.chat.id;
        const session = await getUserSession(chatId);
        const tier = getSubscriptionTier(session);

        if (tier === 'free') {
            return bot.sendMessage(chatId,
                `You are on the free plan.\n\n` +
                `Upgrade to unlock premium features: \`/upgrade\``
            );
        }

        const tierConfig = SUBSCRIPTION_TIERS[tier];
        const expiresAt = session?.subscription_expires_at;

        bot.sendMessage(chatId,
            `💳 *Billing Info*\n\n` +
            `Plan: *${tierConfig.name}*\n` +
            `Price: ₦${tierConfig.priceNGN.toLocaleString()}/month\n` +
            `Source: ${session?.subscription_source || 'unknown'}\n` +
            `Expires: ${expiresAt ? new Date(expiresAt).toLocaleDateString() : 'N/A'}\n\n` +
            `Use \`/upgrade\` to change plan or \`/cancel\` to cancel.`
        );
    });
}
