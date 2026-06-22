import logger from '../core/logger.js';

// ─── Subscription Tiers ────────────────────────────────────────────────────────

export const SUBSCRIPTION_TIERS = {
    free: {
        id: 'free',
        name: 'Free',
        commandsPerDay: 10,
        maxRepos: 1,
        historyDays: 3,
        models: [],        // empty = free models only
        features: ['chat', 'explain_limited', 'models'],
    },
    starter: {
        id: 'starter',
        name: 'Starter',
        priceStars: 50,
        priceNGN: 500,
        commandsPerDay: 50,
        maxRepos: 1,
        historyDays: 30,
        models: ['qwen/qwen-2.5-coder-32b-instruct', 'meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-coder:free', 'deepseek/deepseek-r1:free'],
        features: ['chat', 'explain', 'models', 'smart'],
    },
    pro: {
        id: 'pro',
        name: 'Pro',
        priceStars: 200,
        priceNGN: 2000,
        commandsPerDay: 200,
        maxRepos: 3,
        historyDays: 90,
        models: ['all'],          // special flag = all models
        features: ['chat', 'explain', 'models', 'smart', 'fix', 'compile', 'run', 'build', 'editor', 'rag', 'audit_limited', 'pr_review'],
    },
    team: {
        id: 'team',
        name: 'Team',
        priceStars: 500,
        priceNGN: 5000,
        commandsPerDay: -1,       // unlimited
        maxRepos: -1,             // unlimited
        historyDays: -1,          // unlimited
        models: ['all'],
        features: ['chat', 'explain', 'models', 'smart', 'fix', 'compile', 'run', 'build', 'editor', 'rag', 'audit', 'pr_review', 'multi_repo'],
    },
};

// ─── Subscription Helpers ─────────────────────────────────────────────────────

/**
 * Get the active subscription tier for a user session
 */
export function getSubscriptionTier(session) {
    if (!session) return 'free';
    const tier = session.subscription_tier;
    const expiresAt = session.subscription_expires_at;

    // Check if subscription expired
    if (tier && tier !== 'free' && expiresAt) {
        const expiry = new Date(expiresAt);
        if (expiry < new Date()) {
            return 'free'; // expired, downgrade to free
        }
    }

    return tier || 'free';
}

/**
 * Check if a user has access to a specific feature
 */
export function hasFeature(session, feature) {
    const tier = getSubscriptionTier(session);
    const tierConfig = SUBSCRIPTION_TIERS[tier];
    return tierConfig?.features.includes(feature);
}

/**
 * Check if a user can access a specific AI model
 */
export function canAccessModel(session, modelId) {
    const tier = getSubscriptionTier(session);

    // If tier has 'all' models, grant access
    const tierConfig = SUBSCRIPTION_TIERS[tier];
    if (tierConfig?.models.includes('all')) return true;

    // Check if model is in tier's allowed list
    return tierConfig?.models.includes(modelId);
}

/**
 * Get remaining commands for today based on tier
 */
export function getRemainingCommands(session) {
    const tier = getSubscriptionTier(session);
    const tierConfig = SUBSCRIPTION_TIERS[tier];
    const maxPerDay = tierConfig?.commandsPerDay || 10;

    if (maxPerDay < 0) return -1; // unlimited

    // Count today's commands from chat history
    const today = new Date().toDateString();
    const history = session.command_history || [];
    const todayCommands = history.filter(cmd => new Date(cmd.timestamp).toDateString() === today).length;

    return Math.max(0, maxPerDay - todayCommands);
}

/**
 * Record a command usage
 */
export function recordCommandUsage(session, command) {
    const updated = { ...session };
    updated.command_history = updated.command_history || [];
    updated.command_history.push({
        command,
        timestamp: new Date().toISOString(),
    });
    // Keep only last 30 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    updated.command_history = updated.command_history.filter(
        cmd => new Date(cmd.timestamp) >= cutoff
    );
    return updated;
}

// ─── Subscription Activation ──────────────────────────────────────────────────

/**
 * Activate a subscription for a user
 */
export async function activateSubscription(sessionId, tier, days, source = 'stars') {
    const tierConfig = SUBSCRIPTION_TIERS[tier];
    if (!tierConfig) {
        throw new Error(`Invalid tier: ${tier}`);
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    return {
        subscription_tier: tier,
        subscription_expires_at: expiresAt.toISOString(),
        subscription_source: source,
        subscription_activated_at: new Date().toISOString(),
        subscription_days: days,
    };
}

/**
 * Deactivate a subscription (downgrade to free)
 */
export function deactivateSubscription() {
    return {
        subscription_tier: null,
        subscription_expires_at: null,
        subscription_source: null,
    };
}

// ─── Payment Methods Config ──────────────────────────────────────────────────

export const PAYMENT_METHODS = {
    stars: {
        id: 'stars',
        name: 'Telegram Stars',
        description: '⚡ Instant activation',
        enabled: true,
    },
    bank: {
        id: 'bank',
        name: 'Bank Transfer (Opay/Palmpay)',
        description: '🏦 Manual activation (~5 min)',
        enabled: true,
        details: {
            bank: 'Opay',
            account_number: process.env.PAYMENT_BANK_ACCOUNT || '7012345678',
            account_name: 'AirCommit',
        },
    },
    crypto: {
        id: 'crypto',
        name: 'Crypto (USDT/BNB)',
        description: '💰 Manual activation (~10 min)',
        enabled: true,
        details: {
            usdt_bsc: process.env.PAYMENT_USDT_BSC || '0x0000000000000000000000000000000000000000',
            bnb_bsc: process.env.PAYMENT_BNB_BSC || '0x0000000000000000000000000000000000000000',
        },
    },
};

// ─── Upgrade Message Builder ─────────────────────────────────────────────────

export function buildUpgradeMessage(chatId) {
    const session = null; // caller should pass session
    const tier = null;

    let message = `💎 *AirCommit Premium*\n\n`;
    message += `Unlock the full power of AI coding:\n\n`;

    message += `📦 *Starter* — 50 Stars/week (₦500)\n`;
    message += `   • 50 commands/week\n`;
    message += `   • Smart code suggestions\n\n`;

    message += `🚀 *Pro* — 200 Stars/week (₦2,000)\n`;
    message += `   • 200 commands/week\n`;
    message += `   • AI code fixes, compile & run\n`;
    message += `   • Code editor access\n`;
    message += `   • PR reviews\n\n`;

    message += `👥 *Team* — 500 Stars/week (₦5,000)\n`;
    message += `   • Unlimited commands\n`;
    message += `   • All features + multi-repo\n`;
    message += `   • Team AI memory\n\n`;

    message += `*Pay with:*\n`;
    message += '⭐ Click `/upgrade` for instant payment with Telegram Stars\n';
    message += '🏦 Send `/pay` for bank transfer or crypto\n\n';
    message += `After payment, reply with your proof and we'll activate within 5 minutes!`;

    return message;
}

// ─── Premium Feature Messages ────────────────────────────────────────────────

export function premiumFeatureMessage() {
    return '🔒 *Premium Feature*\n\nThis requires a Starter plan or higher.\n\nUse `/upgrade` to unlock with Telegram Stars.\nOr `/pay` for bank transfer / crypto.';
}

export function commandLimitMessage(remaining) {
    const cmd1 = '`/upgrade`';
    return '⏰ *Daily limit reached*\n\nYou have used your 10 free commands for today.\n\nUpgrade to *Starter* (N500/week) for 50 commands/week.\nUse ' + cmd1 + ' to upgrade now!';
}
