import fs from 'fs';
import path from 'path';
import { CHAT_SYSTEM_PROMPT } from '../core/prompts.js';
import { callChatWithTools } from '../services/ai.js';
import { getUserSession } from '../services/supabase.js';
import { uploadChatArchiveTo0G } from '../services/zerog.js';
import config from '../core/config.js';
import { encrypt } from '../services/supabase.js';

const HISTORY_FILE = path.resolve('./chat_history.json');
const MAX_HISTORY = 20;

function loadHistories() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return new Map(Object.entries(JSON.parse(raw)));
    }
  } catch (e) {
    console.warn('Could not load chat history file, starting fresh:', e.message);
  }
  return new Map();
}

export function saveHistories() {
  try {
    const obj = Object.fromEntries(chatHistories);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Failed to save chat history:', e.message);
  }
}

export const chatHistories = loadHistories();
console.log(`💾 Loaded chat histories from local file for ${chatHistories.size} conversation(s).`);

/**
 * Auto-archive chat to 0G storage
 */
async function autoArchiveChatTo0G(chatId) {
  try {
    if (!config.zerogPrivateKey) {
      return; // 0G not configured
    }

    const history = chatHistories.get(chatId);
    if (!history || history.length < 5) {
      return; // Only archive substantial conversations
    }

    const session = await getUserSession(chatId);
    const encryptedPayload = encrypt(JSON.stringify({
      chatId,
      history,
      archivedAt: new Date().toISOString(),
      user: session?.github_token ? 'authenticated' : 'anonymous',
      modelsUsed: 'unknown'
    }));

    await uploadChatArchiveTo0G(chatId, encryptedPayload);
  } catch (error) {
    console.warn(`⚠️ Auto-archive failed for chat ${chatId}: ${error.message}`);
  }
}

export function registerChatCommands(bot, sendStatus, safeSend) {
  bot.onText(/^\/help$/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `🤖 *AirCommit — IDE Agent Edition*

*Account:*
\`/login\` → Connect GitHub via OAuth or PAT
\`/repos\` → List & select your repositories
\`/status\` → Check full connection & AI status
\`/logout\` → Disconnect account

*AI Model Management:*
\`/models\` → List all free & premium AI models.
\`/model [id]\` → Switch your active AI model.
\`/key [openrouter_key]\` → Link your own API key (BYOK).
\`/key clear\` → Remove your key.

*Active File (IDE Context):*
\`/open [filepath]\` → Set the active file for all commands.
\`/close\` → Clear the active file context.

*Coding Commands:*
\`/fix [instruction]\` → Patch active file (or specify file path).
\`/smart [instruction]\` → Agent scans repo and patches relevant files.
\`/build [instruction]\` → Full IDE agent: plan, install deps, create/patch files.
\`/pr [instruction]\` → Create a branch, patch files, open a Pull Request.
\`/create [filepath] [description]\` → Generate a new file and commit it.

*File Viewer & IDE Tools:*
\`/view [filepath]\` → Read file with ✏️Patch, 🧪Test, 🐞Review, 🗑️Delete, 🖥️Open Editor buttons.
\`/rollback [filepath]\` → Restore to a previous commit.
\`/run [command]\` → Execute a command in a cloned sandbox (e.g. \`/run npm test\`).

*AI & Review:*
\`/review [filepath]\` → Get AI code review.
\`/explain [filepath]\` → Understand the file.
\`/test [filepath]\` → Auto-generate unit tests.
\`/review-pr [pr-number]\` → Review a PR diff.

*Semantic Search (RAG):*
\`/index\` → Vectorize your whole repo into 0G-backed search.
\`/search [query]\` → Semantic code search.

*0G Audit Trail, Backups & Tools:*
\`/audit\` → View decentralized audit log.
\`/backup\` → Backup entire repository to 0G storage.
\`/backups\` → List previous 0G backup hashes.
\`/archive\` → Encrypt & save chat thread to 0G.
\`/load_archive [hash]\` → Restore chat context from 0G.
\`/compile [filepath]\` → Compile Solidity contract & publish to 0G.
\`/report\` → Full platform status for hackathon judges.

*Voice Notes:*
Just send a 🎙 voice message — it will be transcribed and run as a command!

*Local Sync Daemon:*
Run \`node aircommit-sync.js\` in your project folder to auto-sync AI commits via git pull in real-time.`, { parse_mode: 'Markdown' });
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || msg.caption || '';

    if (text.startsWith('/')) return;
    if (!text && !msg.photo) return; // ignore if neither text nor photo

    try {
      bot.sendChatAction(chatId, 'typing');

      if (!chatHistories.has(chatId)) {
        chatHistories.set(chatId, [{ role: 'system', content: CHAT_SYSTEM_PROMPT }]);
      }
      const history = chatHistories.get(chatId);

      let content = text;
      let hasImage = false;
      if (msg.photo && msg.photo.length > 0) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const imageUrl = await bot.getFileLink(fileId);
        content = [{ type: 'image_url', image_url: { url: imageUrl } }];
        if (text) {
          content.push({ type: 'text', text });
        }
        hasImage = true;
      }

      // Append active file context if set
      const session = await getUserSession(chatId);
      if (session && session.active_file) {
        if (hasImage) {
          content.push({ type: 'text', text: `\n\n[Active Context: Regarding file \`${session.active_file}\`]` });
        } else {
          content += `\n\n[Active Context: Regarding file \`${session.active_file}\`]`;
        }
      }

      history.push({ role: 'user', content });

      if (history.length > MAX_HISTORY + 1) {
        history.splice(1, history.length - MAX_HISTORY - 1);
      }

      const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing'), 4000);
      const statusMsg = await bot.sendMessage(chatId, '🧠 Thinking...');
      const editStatus = async (statusText) => {
        try {
          await bot.editMessageText(statusText, { chat_id: chatId, message_id: statusMsg.message_id });
        } catch (_) { }
      };

      let reply, updatedMessages;
      try {
        ({ reply, updatedMessages } = await callChatWithTools(chatId, history, editStatus, hasImage));
      } finally {
        clearInterval(typingInterval);
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
      }

      chatHistories.set(chatId, updatedMessages);
      saveHistories();

      // Auto-archive substantial conversations to 0G
      autoArchiveChatTo0G(chatId);

      if (reply.length > 4000) {
        for (let i = 0; i < reply.length; i += 4000) {
          await safeSend(chatId, reply.slice(i, i + 4000));
        }
      } else {
        await safeSend(chatId, reply);
      }

    } catch (error) {
      bot.sendMessage(chatId, `❌ Chat error: ${error.message}`);
    }
  });

  bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    const voiceFileId = msg.voice.file_id;

    const status = await sendStatus(chatId, `🎙️ Transcribing voice command...`);
    try {
      const fileUrl = await bot.getFileLink(voiceFileId);
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) throw new Error('Failed to download voice file from Telegram.');
      const fileBuffer = await fileRes.arrayBuffer();

      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: 'audio/ogg' });
      formData.append('file', blob, 'voice.ogg');

      let apiUrl, headers, modelName;
      if (config.groqApiKey) {
        apiUrl = 'https://api.groq.com/openai/v1/audio/transcriptions';
        headers = { 'Authorization': `Bearer ${config.groqApiKey}` };
        modelName = 'whisper-large-v3';
      } else if (config.openaiApiKey) {
        apiUrl = 'https://api.openai.com/v1/audio/transcriptions';
        headers = { 'Authorization': `Bearer ${config.openaiApiKey}` };
        modelName = 'whisper-1';
      } else {
        throw new Error('Voice transcription requires GROQ_API_KEY or OPENAI_API_KEY in your .env file.');
      }

      formData.append('model', modelName);

      const res = await fetch(apiUrl, { method: 'POST', headers, body: formData });
      if (!res.ok) throw new Error(`Transcription failed: ${res.statusText}`);

      const json = await res.json();
      const text = json.text;
      await status.update(`🗣️ *Transcribed:* "${text}"\n\nProcessing...`);

      const mockMsg = { ...msg, text };
      const commandMatch = text.match(/^\/?(fix|smart|pr|view|help|create|review|explain|test|rollback|review-pr|report|login|repos|use)\b/i);
      if (commandMatch) {
        const command = commandMatch[1].toLowerCase();
        const rest = text.slice(commandMatch[0].length).trim();
        mockMsg.text = `/${command} ${rest}`.trim();
      }

      await status.delete();
      bot.emit('message', mockMsg);
    } catch (error) {
      await status.update(`❌ Voice processing failed: ${error.message}`);
    }
  });
}
