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
        priceNGN: 5000,
        commandsPerDay: 50,
        maxRepos: 1,
        historyDays: 30,
        models: ['qwen/qwen-2.5-coder-32b-instruct', 'meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-coder:free', 'deepseek/deepseek-r1:free'],
        features: ['chat', 'explain', 'models', 'smart'],
    },
    pro: {
        id: 'pro',
        name: 'Pro',
        priceNGN: 15000,
        commandsPerDay: 200,
        maxRepos: 3,
        historyDays: 90,
        models: ['all'],          // special flag = all models
        features: ['chat', 'explain', 'models', 'smart', 'fix', 'compile', 'run', 'build', 'editor', 'rag', 'audit_limited', 'pr_review'],
    },
    team: {
        id: 'team',
        name: 'Team',
        priceNGN: 30000,
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
export async function activateSubscription(sessionId, tier, days = 30, source = 'paystack') {
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
    paystack: {
        id: 'paystack',
        name: 'Paystack (Card/Bank/USSD)',
        description: '💳 Instant activation via Paystack',
        enabled: !!process.env.PAYSTACK_SECRET_KEY,
    },
    bank: {
        id: 'bank',
        name: 'Bank Transfer (Opay/Palmpay)',
        description: '🏦 Manual activation (~5 min)',
        enabled: !!process.env.PAYMENT_BANK_ACCOUNT && process.env.PAYMENT_BANK_ACCOUNT !== '__SET_REAL_ACCOUNT_IN_ENV__',
        details: {
            bank: 'Opay',
            account_number: process.env.PAYMENT_BANK_ACCOUNT,
            account_name: 'AirCommit',
        },
    },
};

// ─── Upgrade Message Builder ─────────────────────────────────────────────────

export function buildUpgradeMessage(chatId) {
    const session = null; // caller should pass session
    const tier = null;

    let message = `💎 *AirCommit Premium*\n\n`;
    message += `Unlock the full power of AI coding:\n\n`;

    message += `📦 *Starter* — ₦5,000/mo\n`;
    message += `   • 50 commands/month\n`;
    message += `   • Smart code suggestions\n\n`;

    message += `🚀 *Pro* — ₦15,000/mo\n`;
    message += `   • 200 commands/month\n`;
    message += `   • AI code fixes, compile & run\n`;
    message += `   • Code editor access\n`;
    message += `   • PR reviews\n\n`;

    message += `👥 *Team* — ₦30,000/mo\n`;
    message += `   • Unlimited commands\n`;
    message += `   • All features + multi-repo\n`;
    message += `   • Team AI memory\n\n`;

    message += `*Pay with:*\n`;
    message += `💳 Click \`/upgrade\` to pay with Paystack (card, bank, USSD)\n\n`;

    return message;
}

// ─── Premium Feature Messages ────────────────────────────────────────────────

export function premiumFeatureMessage() {
    return '🔒 *Premium Feature*\n\nThis requires a Starter plan or higher.\n\nUse `/upgrade` to activate with Paystack.';
}

export function commandLimitMessage(remaining) {
    const cmd1 = '`/upgrade`';
    return '⏰ *Monthly limit reached*\n\nYou have used your commands for this billing period.\n\nUpgrade to *Starter* (₦5,000/mo) for 50 commands/month.\nUse ' + cmd1 + ' to upgrade now!';
}
