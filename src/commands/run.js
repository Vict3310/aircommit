import { requireSession } from '../services/github.js';
import { getSyncedRepoPath } from '../services/sync.js';
import { executeInSandbox } from '../services/sandbox.js';
import { getUserSession } from '../services/supabase.js';
import { hasFeature, premiumFeatureMessage } from '../services/subscription.js';

export function registerRunCommands(bot, sendStatus) {
  bot.onText(/^\/run\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const command = match[1].trim();

    // Check subscription
    const session = await getUserSession(chatId);
    if (!hasFeature(session, 'run')) {
      return bot.sendMessage(chatId, premiumFeatureMessage());
    }

    // The Docker container offers some isolation, but we still block obvious escapes
    // just in case we fall back to host in the future or have container escapes.
    const BLOCKED = ['rm -rf /', 'sudo'];
    if (BLOCKED.some(b => command.toLowerCase().includes(b))) {
      bot.sendMessage(chatId, `🚫 *Blocked Command*\nFor security reasons, \`${command}\` is not allowed.`, { parse_mode: 'Markdown' });
      return;
    }

    const status = await sendStatus(chatId, `⚡ *Running Sandbox*\n\`$ ${command}\`\n\n_Syncing repository to local environment..._`);

    try {
      const { owner, repo, github_token } = await requireSession(chatId);

      // Get or create the synchronized local clone
      const repoDir = await getSyncedRepoPath(chatId, owner, repo, github_token);

      await status.update(`⚡ *Running Sandbox*\n\`$ ${command}\`\n\n_Executing in Docker..._`);

      const { stdout, stderr } = await executeInSandbox(command, repoDir);

      // Format output nicely
      let output = '';
      if (stdout) output += `*stdout:*\n\`\`\`\n${stdout.slice(0, 2000)}\n\`\`\``;
      if (stderr) output += `\n*stderr:*\n\`\`\`\n${stderr.slice(0, 800)}\n\`\`\``;
      if (!output) output = '✅ Command ran with no output.';

      await status.update(`⚡ *Sandbox Result:* \`$ ${command}\`\n\n${output}`);
    } catch (error) {
      await status.update(`❌ Sandbox error: ${error.message}`);
    }
  });
}
