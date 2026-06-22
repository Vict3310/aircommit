import { chatHistories } from './chat.js';
import { CHAT_SYSTEM_PROMPT } from '../core/prompts.js';
import { getUserSession } from '../services/supabase.js';
import { hasFeature, premiumFeatureMessage } from '../services/subscription.js';
import { checkBotRateLimit } from '../core/rate-limit.js';

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

    // Initialize session if it doesn't exist
    if (!chatHistories.has(chatId)) {
      chatHistories.set(chatId, [{ role: 'system', content: CHAT_SYSTEM_PROMPT }]);
    }

    bot.sendMessage(chatId, `🤖 *Agent Mode Activated*\nI will now autonomously research, plan, and execute your request:\n\n_${intent}_`, { parse_mode: 'Markdown' });

    // Construct a powerful prompt that forces the AI into an agentic workflow
    const prompt = `I want to build a new feature or make a significant change. My intent is:
"${intent}"

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
