import { saveUserSession, getUserSession } from '../services/supabase.js';
import {
    SUBSCRIPTION_TIERS,
    PAYMENT_METHODS,
    activateSubscription,
    premiumFeatureMessage,
    getSubscriptionTier,
} from '../services/subscription.js';
import logger from '../core/logger.js';
import config from '../core/config.js';

// ─── Admin Setup ─────────────────────────────────────────────────────────────

/**
 * Get admin chat IDs from environment
 */
function getAdminChatIds() {
    const adminsRaw = process.env.ADMIN_CHAT_IDS || '';
    if (!adminsRaw) return [];
    return adminsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

/**
 * Check if a chat ID is an admin
 */
function isAdmin(chatId) {
    return getAdminChatIds().includes(chatId);
}

// ─── /upgrade Command (Telegram Stars Invoice) ────────────────────────────────

export function registerPaymentCommands(bot) {
    // /upgrade — show pricing and create Stars invoice
    bot.onText(/^\/upgrade$/, async (msg) => {
        const chatId = msg.chat.id;
        const session = await getUserSession(chatId);
        const currentTier = getSubscriptionTier(session);

        if (currentTier !== 'free') {
            const tierConfig = SUBSCRIPTION_TIERS[currentTier];
            const cmdStatus = '`/status`';
            return bot.sendMessage(chatId,
                `✅ You are already on the *${tierConfig.name}* plan.\n\n` +
                'Use ' + cmdStatus + ' to see your plan details.'
            );
        }

        // Create inline keyboard for Stars invoice tiers
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📦 Starter — 50 Stars', callback_data: 'pay_starter' },
                ],
                [
                    { text: '🚀 Pro — 200 Stars', callback_data: 'pay_pro' },
                ],
                [
                    { text: '👥 Team — 500 Stars', callback_data: 'pay_team' },
                ],
                [
                    { text: '🏦 Bank Transfer', callback_data: 'pay_bank' },
                    { text: '💰 Crypto', callback_data: 'pay_crypto' },
                ],
            ],
        };

        bot.sendMessage(chatId,
            `💎 *AirCommit Premium*\n\n` +
            `Unlock the full power of AI coding:\n\n` +
            `📦 *Starter* — 50 Stars/week (N500)\n` +
            `   • 50 commands/week\n` +
            `   • Smart code suggestions\n\n` +
            `🚀 *Pro* — 200 Stars/week (N2,000)\n` +
            `   • 200 commands/week\n` +
            `   • AI code fixes, compile & run\n` +
            `   • Code editor access\n` +
            `   • PR reviews\n\n` +
            `👥 *Team* — 500 Stars/week (N5,000)\n` +
            `   • Unlimited commands\n` +
            `   • All features + multi-repo\n` +
            `   • Team AI memory\n\n` +
            `Click a plan below to upgrade:`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    });

    // Handle Stars payment callback
    bot.on('callback_query', async (callbackQuery) => {
        const chatId = callbackQuery.message?.chat?.id;
        if (!chatId) return;

        const data = callbackQuery.data;
        const msgId = callbackQuery.message?.message_id;

        if (!data || !msgId) return;

        // Answer callback to remove loading state
        bot.answerCallbackQuery({ callback_query_id: callbackQuery.id });

        switch (data) {
            case 'pay_starter':
            case 'pay_pro':
            case 'pay_team': {
                const tier = data.replace('pay_', '');
                const tierConfig = SUBSCRIPTION_TIERS[tier];

                // Create Stars invoice
                try {
                    const invoice = await bot.sendInvoice(
                        chatId,
                        `AirCommit ${tierConfig.name} Upgrade`,
                        `${tierConfig.priceStars} Telegram Stars — weekly subscription`,
                        `aircommit_${tier}_${Date.now()}`,
                        'STAR',
                        [
                            {
                                label: `${tierConfig.name} (1 week)`,
                                amount: tierConfig.priceStars,
                                currency: 'STAR',
                            },
                        ]
                    );

                    bot.sendMessage(chatId,
                        `⏳ *Payment Required*\n\n` +
                        `Please complete the payment above to activate your ${tierConfig.name} plan.\n\n` +
                        `Once paid, your account will be upgraded automatically.`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (error) {
                    logger.error({ component: 'payment', error: error.message }, 'Stars invoice creation failed');
                    bot.sendMessage(chatId,
                        `❌ Failed to create payment. Please try again or use bank transfer with \`/pay\`.`
                    );
                }
                break;
            }

            case 'pay_bank':
                bot.editMessageText(
                    `🏦 *Bank Transfer Payment*\n\n` +
                    `Send payment to:\n\n` +
                    `🏦 **Bank:** Opay\n` +
                    `🔢 **Account:** ${PAYMENT_METHODS.bank.details.account_number}\n` +
                    `👤 **Name:** ${PAYMENT_METHODS.bank.details.account_name}\n\n` +
                    `*Amounts:*\n` +
                    `• Starter: N500/week\n` +
                    `• Pro: N2,000/week\n` +
                    `• Team: N5,000/week\n\n` +
                    `After payment, *reply to this message* with:\n` +
                    `• Amount sent\n` +
                    `• Phone number used\n\n` +
                    `We'll activate within 5 minutes.`,
                    { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
                );
                break;

            case 'pay_crypto':
                bot.editMessageText(
                    `💰 *Crypto Payment*\n\n` +
                    `Send USDT (BSC) or BNB to:\n\n` +
                    `**USDT (BSC):**\n\`\`\`\n${PAYMENT_METHODS.crypto.details.usdt_bsc}\n\`\`\`\n\n` +
                    `**BNB (BSC):**\n\`\`\`\n${PAYMENT_METHODS.crypto.details.bnb_bsc}\n\`\`\`\n\n` +
                    `*Amounts (in USDT equivalent):*\n` +
                    `• Starter: $3/week (~50 Stars)\n` +
                    `• Pro: $12/week (~200 Stars)\n` +
                    `• Team: $30/week (~500 Stars)\n\n` +
                    `After payment, *reply to this message* with:\n` +
                    `• Transaction hash\n` +
                    `• Network (BSC mainnet)\n\n` +
                    `We'll activate within 10 minutes.`,
                    { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
                );
                break;
        }
    });

    // /pay — show payment options without Stars
    bot.onText(/^\/pay$/, async (msg) => {
        const chatId = msg.chat.id;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '⭐ Pay with Stars', callback_data: 'pay_starter' },
                ],
                [
                    { text: '🏦 Bank Transfer', callback_data: 'pay_bank' },
                    { text: '💰 Crypto', callback_data: 'pay_crypto' },
                ],
            ],
        };

        bot.sendMessage(chatId,
            `💎 *Pay for AirCommit*\n\n` +
            `Choose your preferred payment method:\n\n` +
            `⭐ **Telegram Stars** — instant activation\n` +
            `🏦 **Bank Transfer** — Opay/Palmpay\n` +
            `💰 **Crypto** — USDT/BNB on BSC\n\n` +
            `Click a method to get started:`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    });

    // Handle reply to bank/crypto messages (manual payment proof)
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;
        if (!text || !msg.reply_to_message) return;

        // Check if replying to a payment message
        const replyTo = msg.reply_to_message;
        if (!replyTo || !replyTo.text) return;

        const originalText = replyTo.text;
        const isBankReply = originalText.includes('Bank Transfer');
        const isCryptoReply = originalText.includes('Crypto Payment');

        if (isBankReply || isCryptoReply) {
            // Parse user's payment proof from reply text
            // Expected format: "amount phone" or "amount tx_hash"
            const parts = text.split(/\s+/);
            if (parts.length < 2) {
                bot.sendMessage(chatId,
                    `Please reply with your payment details:\n` +
                    `• Amount sent (e.g., 2000)\n` +
                    `• Phone number or transaction hash\n\n` +
                    `Example: \`2000 0801234567\``
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
            adminNotify += `💰 Amount: ${amount}\n`;
            adminNotify += `🔑 Proof: \`${proof}\`\n`;
            adminNotify += `💳 Method: ${paymentMethod}\n`;
            adminNotify += `⏰ ${new Date().toISOString()}`;

            for (const adminId of adminIds) {
                try {
                    const activateKeyboard = {
                        inline_keyboard: [
                            [
                                { text: '✅ Activate Starter', callback_data: `admin_activate_starter_${chatId}` },
                                { text: '✅ Activate Pro', callback_data: `admin_activate_pro_${chatId}` },
                                { text: '✅ Activate Team', callback_data: `admin_activate_team_${chatId}` },
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

    // Handle admin activation callbacks
    bot.on('callback_query', async (callbackQuery) => {
        const data = callbackQuery.data;
        if (!data) return;

        // Admin activation: admin_activate_<tier>_<chatId>
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
                const subscriptionData = await activateSubscription(userChatId, tier, 7, 'manual');
                await saveUserSession(userChatId, subscriptionData);

                bot.answerCallbackQuery({
                    callback_query_id: callbackQuery.id,
                    text: `Activated ${tier} for user`,
                });

                bot.sendMessage(adminChatId,
                    `✅ Activated *${tier}* for chat \`${userChatId}\`.\n` +
                    `Expires: ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()}`
                );

                bot.sendMessage(userChatId,
                    `🎉 *${tier.charAt(0).toUpperCase() + tier.slice(1)} Activated!*\n\n` +
                    `Your AirCommit ${tier.charAt(0).toUpperCase() + tier.slice(1)} plan is now active for 7 days.\n\n` +
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
        message += `• Commands: ${tierConfig.commandsPerDay < 0 ? 'Unlimited' : tierConfig.commandsPerDay + '/week'}\n`;
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

    // Handle cancel callbacks
    bot.on('callback_query', async (callbackQuery) => {
        const data = callbackQuery.data;
        const chatId = callbackQuery.message?.chat?.id;
        if (!chatId) return;

        if (data === 'cancel_sub') {
            const session = await getUserSession(chatId);
            const tier = getSubscriptionTier(session);

            if (tier === 'free') {
                bot.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'No active subscription' });
                return;
            }

            // Don't delete, just set expiry to now so it auto-downgrades
            await saveUserSession(chatId, {
                subscription_cancelled_at: new Date().toISOString(),
            });

            bot.answerCallbackQuery({
                callback_query_id: callbackQuery.id,
                text: 'Subscription cancelled. Active until expiry.',
            });

            bot.editMessageText(
                `✅ Subscription cancelled.\n\n` +
                `Your plan remains active until the end of your billing period.\n` +
                `You'll be notified before downgrading.`,
                { chat_id: chatId, message_id: callbackQuery.message.message_id }
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
                { chat_id: chatId, message_id: callbackQuery.message.message_id }
            );
        }
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
            `Price: ${tierConfig.priceStars} Stars/week (${tierConfig.priceNGN}/week)\n` +
            `Source: ${session?.subscription_source || 'unknown'}\n` +
            `Expires: ${expiresAt ? new Date(expiresAt).toLocaleDateString() : 'N/A'}\n\n` +
            `Use \`/upgrade\` to change plan or \`/cancel\` to cancel.`
        );
    });
}