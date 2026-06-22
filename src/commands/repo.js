import { Octokit } from '@octokit/rest';
import { getUserSession, saveUserSession } from '../services/supabase.js';

export function registerRepoCommands(bot) {
  bot.onText(/^\/repos$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const session = await getUserSession(chatId);
      if (!session || !session.github_token) throw new Error('Not logged in. Use `/login`.');
      
      const octokit = new Octokit({ auth: session.github_token });
      const { data } = await octokit.repos.listForAuthenticatedUser({ sort: 'updated', per_page: 15 });
      
      if (data.length === 0) {
        return bot.sendMessage(chatId, `📁 You don't have any repositories yet.`);
      }
      
      const keyboard = data.map(r => [{ text: r.full_name, callback_data: `use_repo:${r.owner.login}:${r.name}` }]);
      bot.sendMessage(chatId, `📁 *Recent Repositories:*\nSelect a repository to work on:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Error: ${e.message}`, { parse_mode: 'Markdown' });
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('use_repo:')) {
      const parts = data.split(':');
      if (parts.length === 3) {
        const owner = parts[1];
        const repo = parts[2];
        
        try {
          const session = await getUserSession(chatId);
          if (!session || !session.github_token) throw new Error('Not logged in.');
          
          const octokit = new Octokit({ auth: session.github_token });
          await octokit.repos.get({ owner, repo });
          
          await saveUserSession(chatId, { active_owner: owner, active_repo: repo });
          bot.sendMessage(chatId, `✅ Active repository set to: *${owner}/${repo}*\n\nYou can now use \`/fix\`, \`/smart\`, etc.`, { parse_mode: 'Markdown' });
        } catch (e) {
          bot.sendMessage(chatId, `❌ Could not access repository *${owner}/${repo}*. Error: ${e.message}`, { parse_mode: 'Markdown' });
        }
      }
      bot.answerCallbackQuery(query.id);
    }
  });

  bot.onText(/^\/use\s+(.+)\/(.+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const owner = match[1];
    const repo = match[2];
    
    try {
      const session = await getUserSession(chatId);
      if (!session || !session.github_token) throw new Error('Not logged in. Use `/login`.');
      
      const octokit = new Octokit({ auth: session.github_token });
      await octokit.repos.get({ owner, repo });
      
      await saveUserSession(chatId, { active_owner: owner, active_repo: repo });
      bot.sendMessage(chatId, `✅ Active repository set to: *${owner}/${repo}*\n\nYou can now use \`/fix\`, \`/smart\`, etc.`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Could not access repository *${owner}/${repo}*. Are you sure it exists and you have access?`, { parse_mode: 'Markdown' });
    }
  });
}
