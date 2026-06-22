import { requireSession, fetchFile } from '../services/github.js';
import { saveUserSession } from '../services/supabase.js';
import config from '../core/config.js';

export function registerContextCommands(bot, sendStatus) {
  bot.onText(/^\/open\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const filePath = match[1];

    const status = await sendStatus(chatId, `🔍 Opening \`${filePath}\`...`);
    try {
      const session = await requireSession(chatId);
      
      // Verify file exists
      await fetchFile(session.octokit, session.owner, session.repo, filePath);
      
      await saveUserSession(chatId, { active_file: filePath });
      
      await status.delete();
      bot.sendMessage(chatId, `✅ **Active File Set:** \`${filePath}\`\nAny chat message or \`/fix\`, \`/test\`, \`/review\` will now target this file automatically.`, { parse_mode: 'Markdown' });
    } catch (error) {
      if (error.status === 404) {
        await status.update(`❌ File not found in repo: \`${filePath}\``);
      } else {
        await status.update(`❌ Error opening file: ${error.message}`);
      }
    }
  });

  bot.onText(/^\/edit(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    let filePath = match[1];

    const status = await sendStatus(chatId, `🔍 Preparing editor...`);
    try {
      const session = await requireSession(chatId);
      filePath = filePath || session.active_file;
      
      if (!filePath) {
        throw new Error('Please specify a file path or /open a file first.');
      }
      
      // Verify file exists
      await fetchFile(session.octokit, session.owner, session.repo, filePath);
      await saveUserSession(chatId, { active_file: filePath });
      
      await status.delete();
      const keyboard = [
        [{ text: '🖥️ Open Editor', web_app: { url: `${config.baseUrl}/editor?file=${encodeURIComponent(filePath)}&chatId=${chatId}` } }]
      ];
      bot.sendMessage(chatId, `✅ **Active File:** \`${filePath}\`\nClick below to open the Monaco Editor:`, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (error) {
      if (error.status === 404) {
        await status.update(`❌ File not found in repo: \`${filePath}\``);
      } else {
        await status.update(`❌ Error: ${error.message}`);
      }
    }
  });

  bot.onText(/^\/close/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await saveUserSession(chatId, { active_file: null });
      bot.sendMessage(chatId, `✅ Active file cleared.`, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
  });
}
