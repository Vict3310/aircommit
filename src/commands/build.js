import { chatHistories } from './chat.js';
import { CHAT_SYSTEM_PROMPT } from '../core/prompts.js';
import { getUserSession } from '../services/supabase.js';
import { hasFeature, premiumFeatureMessage } from '../services/subscription.js';
import { checkBotRateLimit } from '../core/rate-limit.js';

// ─── Prompt Injection Detection ──────────────────────────────────────────────

/**
 * Detects common prompt injection patterns in user input.
 * Returns the sanitized intent or null if injection is detected.
 */
function sanitizePromptInjection(intent) {
  if (typeof intent !== 'string') return null;

  const sanitized = intent.trim();

  // Block prompt injection keywords that suggest overriding AI behavior
  const injectionPatterns = [
    /\b(ignore|disregard|bypass|skip)\s+(previous|above|system|my)\s+(instructions|prompt|rules|warnings)\b/i,
    /\b(you\s+are\s+a?|act\s+as\s+a?|pretend\s+to\s+be)\s+(developer|admin|root|god|superuser)\b/i,
    /\b(show|output|print|display|reveal)\s+(my|the|your|all)\s+(key|token|secret|password|api|credential)/i,
    /\b(don't|do not)\s+(stop|quit|halt|cease)\s+(responding|replying|answering)\b/i,
    /\b(begin|start|now)\s+(generating|outputting|sending)\s+(email|message)\s+to\b/i,
    /\b(end\s+task|abort\s+mission|stop\s+all)\b/i,
    /^(\/|!|#)\s*\w+/i,  // Shell command prefix (not a feature request)
    /\b(translate|explain|summarize|review|fix|debug)\s+(this\s+)?file\b/i,  // Commands that should use /fix etc.
  ];

  for (const pattern of injectionPatterns) {
    if (pattern.test(sanitized)) {
      console.warn('[Build] Potential prompt injection detected and blocked:', sanitized.substring(0, 100));
      return null;
    }
  }

  // Truncate excessively long prompts to prevent token exhaustion
  if (sanitized.length > 500) {
    console.warn('[Build] Prompt truncated from', sanitized.length, 'to 500 chars');
    return sanitized.substring(0, 500);
  }

  return sanitized;
}

export function registerBuildCommands(bot, sendStatus) {

  bot.onText(/^\/build\s+(.+)/s, async (msg, match) => {
    const chatId = msg.chat.id;
    const intent = match[1].trim();

    // Check subscription
    const session = await getUserSession(chatId);
    if (!hasFeature(session, 'smart')) {
      return bot.sendMessage(chatId, premiumFeatureMessage());
    }

    // Check rate limit
    const rl = checkBotRateLimit(chatId, 'heavy');
    if (rl) {
      return bot.sendMessage(chatId, rl);
    }

    // Sanitize prompt for injection attacks
    const sanitizedIntent = sanitizePromptInjection(intent);
    if (!sanitizedIntent) {
      return bot.sendMessage(chatId, '⚠️ Invalid or suspicious input detected. Please rephrase your request.');
    }

    // Initialize session if it doesn't exist
    if (!chatHistories.has(chatId)) {
      chatHistories.set(chatId, [{ role: 'system', content: CHAT_SYSTEM_PROMPT }]);
    }

    bot.sendMessage(chatId, `🤖 *Agent Mode Activated*\nI will now autonomously research, plan, and execute your request:\n\n_${sanitizedIntent}_`, { parse_mode: 'Markdown' });

    // Construct a powerful prompt that forces the AI into an agentic workflow
    const prompt = `I want to build a new feature or make a significant change. My intent is:
"${sanitizedIntent}"

Please act as an autonomous agent:
1. Use \`list_repo_files\` and \`read_file\` to thoroughly research the repository and understand the context.
2. If you need new npm packages, use \`manage_dependencies\` to install them.
3. Once you understand exactly what to do, explain your plan briefly.
4. Finally, execute the changes using \`create_or_overwrite_file\` and \`patch_file\`.`;

    // Create a mock message to trigger the standard chat loop
    const mockMsg = { ...msg, text: prompt };

    // Use process.nextTick for synchronous deferral (avoids setTimeout race conditions)
    process.nextTick(() => {
      bot.emit('message', mockMsg);
    });
  });
}
