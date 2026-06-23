import { saveUserSession, getUserSession } from '../services/supabase.js';
import {
    SUBSCRIPTION_TIERS,
    activateSubscription,
    getSubscriptionTier,
} from '../services/subscription.js';
import logger from '../core/logger.js';
import config from '../core/config.js';

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
            `⚡ Select a plan to pay with Telegram Stars:`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
        );
    });

    // Handle Stars payment callback (invoice creation)
    bot.on('callback_query', async (callbackQuery) => {
        const chatId = callbackQuery.message?.chat?.id;
        if (!chatId) return;

        const data = callbackQuery.data;
        const msgId = callbackQuery.message?.message_id;

        if (!data || !msgId) return;

        // Answer callback to remove loading state
        bot.answerCallbackQuery({ callback_query_id: callbackQuery.id });

        // Stars invoice creation
        if (data === 'pay_starter' || data === 'pay_pro' || data === 'pay_team') {
            const tier = data.replace('pay_', '');
            const tierConfig = SUBSCRIPTION_TIERS[tier];

            try {
                await bot.sendInvoice(
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
            } catch (error) {
                logger.error({ component: 'payment', error: error.message }, 'Stars invoice creation failed');
                bot.sendMessage(chatId,
                    `❌ Failed to create payment. Please try again with \`/upgrade\`.`
                );
            }
            return;
        }

        // Cancel/keep subscription
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
                    `Your plan remains active until the end of your billing period.\n` +
                    `You'll be notified before downgrading.`,
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

    // Handle successful Stars payment — AUTO-ACTIVATE
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const successfulPayment = msg.successful_payment;

        if (!successfulPayment) return;

        const invoicePayload = successfulPayment.invoice_payload;
        if (!invoicePayload?.startsWith('aircommit_')) return;

        // Parse tier from payload: "aircommit_pro_1706745600000"
        const parts = invoicePayload.split('_');
        if (parts.length < 3) return;

        const tier = parts[1];
        const tierConfig = SUBSCRIPTION_TIERS[tier];

        if (!tierConfig) {
            logger.warn({ component: 'payment', payload: invoicePayload }, 'Invalid tier in Stars payment');
            return;
        }

        try {
            // Auto-activate subscription on successful payment
            const subscriptionData = await activateSubscription(chatId, tier, 7, 'stars');
            await saveUserSession(chatId, subscriptionData);

            bot.sendMessage(chatId,
                `🎉 *${tierConfig.name} Activated!*\n\n` +
                `Your AirCommit ${tierConfig.name} plan is now active for 7 days.\n\n` +
                `✨ *Features unlocked:*\n` +
                `• Commands: ${tierConfig.commandsPerDay < 0 ? 'Unlimited' : tierConfig.commandsPerDay + '/week'}\n` +
                `• Repos: ${tierConfig.maxRepos < 0 ? 'Unlimited' : tierConfig.maxRepos}\n\n` +
                `Use \`/status\` to see your plan details.`
            );
        } catch (error) {
            logger.error({ component: 'payment', error: error.message }, 'Stars payment activation failed');
            bot.sendMessage(chatId,
                `❌ Payment received but activation failed. Please contact support.`
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