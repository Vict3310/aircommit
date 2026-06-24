import 'dotenv/config';

// ─── Security Configuration ────────────────────────────────────────────────────

// Minimum required lengths for security secrets
const MIN_WEBHOOK_SECRET_LENGTH = 32;
const MIN_ENCRYPTION_KEY_LENGTH = 32;

/**
 * Validates and sanitizes environment configuration
 * Returns warnings for non-critical issues, throws for critical ones
 */
function validateConfig() {
  const warnings = [];
  const errors = [];

  // Required: Telegram Bot Token
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    errors.push('TELEGRAM_BOT_TOKEN is required');
  } else if (process.env.TELEGRAM_BOT_TOKEN.length < 30) {
    errors.push('TELEGRAM_BOT_TOKEN appears too short - may be invalid');
  }

  // Required: OpenRouter API Key
  if (!process.env.OPENROUTER_API_KEY) {
    errors.push('OPENROUTER_API_KEY is required');
  }

  // Optional but recommended: GitHub credentials
  if (process.env.GITHUB_CLIENT_ID && !process.env.GITHUB_CLIENT_SECRET) {
    warnings.push('GITHUB_CLIENT_ID is set but GITHUB_CLIENT_SECRET is missing');
  }
  if (process.env.GITHUB_CLIENT_SECRET && !process.env.GITHUB_CLIENT_ID) {
    warnings.push('GITHUB_CLIENT_SECRET is set but GITHUB_CLIENT_ID is missing');
  }

  // Webhook secret validation
  if (process.env.WEBHOOK_URL && !process.env.GITHUB_WEBHOOK_SECRET) {
    errors.push('GITHUB_WEBHOOK_SECRET is required when WEBHOOK_URL is configured');
  }
  if (process.env.GITHUB_WEBHOOK_SECRET && process.env.GITHUB_WEBHOOK_SECRET.length < MIN_WEBHOOK_SECRET_LENGTH) {
    errors.push(`GITHUB_WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters long`);
  }

  // Encryption key validation
  if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length < MIN_ENCRYPTION_KEY_LENGTH) {
    errors.push(`ENCRYPTION_KEY must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters long`);
  }

  // Supabase validation
  if (process.env.SUPABASE_URL && !process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_ANON_KEY) {
    warnings.push('SUPABASE_URL is set but no Supabase key is configured');
  }

  // 0G validation
  if (process.env.ZEROG_PRIVATE_KEY) {
    // Basic format check for private key (hex or base64)
    const isHex = /^[a-fA-F0-9]{64}$/.test(process.env.ZEROG_PRIVATE_KEY);
    const isBase64 = /^[A-Za-z0-9+/]+=*$/.test(process.env.ZEROG_PRIVATE_KEY);
    if (!isHex && !isBase64) {
      warnings.push('ZEROG_PRIVATE_KEY does not appear to be a valid hex or base64 string');
    }
  }

  // Port validation
  const port = parseInt(process.env.PORT, 10);
  if (process.env.PORT && (isNaN(port) || port < 1 || port > 65535)) {
    errors.push('PORT must be a valid port number (1-65535)');
  }

  return { warnings, errors };
}

// Validate configuration
const validation = validateConfig();

// Log warnings
validation.warnings.forEach(w => console.warn('⚠️  Config warning:', w));

// Throw on errors
if (validation.errors.length > 0) {
  console.error('❌ Configuration errors:');
  validation.errors.forEach(e => console.error('  -', e));
  console.error('\nPlease check your .env file. See .env.example for required variables.');
  process.exit(1);
}

const config = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  openrouterKey: process.env.OPENROUTER_API_KEY,

  githubClientId: process.env.GITHUB_CLIENT_ID,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET,

  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  webhookUrl: process.env.WEBHOOK_URL,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,

  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,

  encryptionKey: process.env.ENCRYPTION_KEY,

  codingModel: process.env.CODING_MODEL || 'qwen/qwen-2.5-coder-32b-instruct',
  chatModel: process.env.CHAT_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free',

  groqApiKey: process.env.GROQ_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,

  zerogPrivateKey: process.env.ZEROG_PRIVATE_KEY,
  zerogEvmRpc: process.env.ZEROG_EVM_RPC_URL || 'https://evmrpc-testnet.0g.ai',
  zerogIndexerRpc: process.env.ZEROG_INDEXER_RPC_URL || 'https://indexer-storage-testnet-standard.0g.ai',
  zerogFallbackNodes: process.env.ZEROG_FALLBACK_NODES || 'https://rpc-storage-testnet.0g.ai',

  // Payment & subscription config
  // WARNING: These values are shown to users for manual payments.
  // MUST be set via environment variables before production.
  adminChatIds: process.env.ADMIN_CHAT_IDS || '',
  paymentBankAccount: process.env.PAYMENT_BANK_ACCOUNT || '__PLACEHOLDER_SET_REAL_VALUE__',

  // Validation results (for runtime checks)
  _validation: validation
};

// Runtime security check for webhook secret (in case it was loaded late)
if (config.webhookUrl && (!config.githubWebhookSecret || config.githubWebhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH)) {
  console.error('[Security] GITHUB_WEBHOOK_SECRET is required and must be at least 32 characters when WEBHOOK_URL is set.');
  process.exit(1);
}

// Runtime check: warn if payment placeholders are still set
if (config.paymentBankAccount === '__PLACEHOLDER_SET_REAL_VALUE__') {
  console.error('[CRITICAL] PAYMENT_BANK_ACCOUNT is set to a placeholder. Update PAYMENT_BANK_ACCOUNT in your .env before going live.');
  process.exit(1);
}

export default config;
