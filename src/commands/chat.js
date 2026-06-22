import fs from 'fs';
import path from 'path';
import { CHAT_SYSTEM_PROMPT } from '../core/prompts.js';
import { callChatWithTools } from '../services/ai.js';
import { getUserSession, saveUserSession } from '../services/supabase.js';
import { uploadChatArchiveTo0G, uploadAuditLogTo0G } from '../services/zerog.js';
import { commitChangesWithTree, getDefaultBranch, createWriteOctokit, invalidateFileTree } from '../services/github.js';
import config from '../core/config.js';
import { encrypt } from '../services/supabase.js';
import { fetchWithTimeout } from '../core/fetch-timeout.js';

const HISTORY_FILE = path.resolve('./chat_history.json');
const MAX_HISTORY = 20;
const MAX_CHATS = 500; // LRU bound: evict least recently active chats when map exceeds this
const INACTIVE_CHAT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Last-chance TTL for inactive chat histories (purged on save).
 */
function purgeStaleChats() {
  const now = Date.now();
  for (const [chatId, meta] of Object.entries(chatHistories.metadata || {})) {
    if (meta.lastActive && (now - meta.lastActive) > INACTIVE_CHAT_TTL) {
      chatHistories.delete(chatId);
      if (chatHistories.metadata) delete chatHistories.metadata[chatId];
    }
  }
}

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
  purgeStaleChats();
  try {
    const obj = Object.fromEntries(chatHistories);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ ...obj, _metadata: chatHistories.metadata }, null, 2));
  } catch (e) {
    console.error('Failed to save chat history:', e.message);
  }
}

export const chatHistories = loadHistories();
chatHistories.metadata = chatHistories.metadata || {};
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
        chatHistories.metadata[chatId] = { lastActive: Date.now() };
        // LRU eviction: when map exceeds MAX_CHATS, evict the least recently active chat
        if (chatHistories.size > MAX_CHATS) {
          let oldestKey = null;
          let oldestTime = Infinity;
          for (const [key, meta] of Object.entries(chatHistories.metadata)) {
            if (meta.lastActive < oldestTime) {
              oldestTime = meta.lastActive;
              oldestKey = key;
            }
          }
          if (oldestKey) {
            chatHistories.delete(oldestKey);
            delete chatHistories.metadata[oldestKey];
            console.log(`[Chat] Evicted least active chat ${oldestKey} (LRU, size=${chatHistories.size}/${MAX_CHATS})`);
          }
        }
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

      let reply, updatedMessages, pendingChanges;
      try {
        ({ reply, updatedMessages, pendingChanges } = await callChatWithTools(chatId, history, editStatus, hasImage));
      } finally {
        clearInterval(typingInterval);
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
      }

      chatHistories.set(chatId, updatedMessages);
      chatHistories.metadata[chatId] = { lastActive: Date.now() };
      saveHistories();

      // Auto-archive substantial conversations to 0G
      autoArchiveChatTo0G(chatId);

      // Handle approve/reject for pending chat changes
      const normalizedText = (text || '').trim().toLowerCase();
      if (pendingChanges && normalizedText === 'approve') {
        try {
          const { changes, commitMessage, owner, repoName, chatId: pcChatId } = pendingChanges;
          const writeOctokit = createWriteOctokit(session.github_token);
          const defaultBranch = await getDefaultBranch(writeOctokit, owner, repoName);
          await commitChangesWithTree(writeOctokit, owner, repoName, defaultBranch, commitMessage, changes);
          await invalidateFileTree(owner, repoName);

          // Track in session history
          const actionHistory = session.action_history || [];
          actionHistory.push({ action: commitMessage, file: changes.map(c => c.path).join(', '), timestamp: new Date().toISOString() });
          await saveUserSession(pcChatId, { action_history: actionHistory.slice(-50) });

          // Upload audit to 0G
          const auditData = {
            timestamp: new Date().toISOString(),
            type: 'agent_edit',
            repo: `${owner}/${repoName}`,
            commitMessage,
            steps: changes.map(c => ({ file: c.path, action: c.action, status: '✅' })),
            approvedByChatId: pcChatId,
          };
          let zgRes;
          let zgErr = null;
          try {
            // Retry once on failure (transient network issue)
            try {
              zgRes = await uploadAuditLogTo0G(auditData);
            } catch (retryErr) {
              console.warn('[Audit] 0G upload failed, retrying once...', retryErr.message);
              zgRes = await uploadAuditLogTo0G(auditData);
            }
          } catch (e) {
            zgErr = e;
          }
          if (zgRes) {
            await safeSend(pcChatId, `✅ Changes committed & logged to 0G!\nTx: \`${zgRes.txHash}\``);
          } else {
            const warnMsg = `✅ Changes committed!\n\n⚠️ *0G audit trail incomplete* — your changes were committed successfully, but the decentralized log could not be stored.\n` +
              (zgErr ? `_(Reason: ${zgErr.message}_)` : '');
            await safeSend(pcChatId, warnMsg);
          }
        } catch (commitErr) {
          await safeSend(chatId, `❌ Commit failed: ${commitErr.message}`);
        }
        return; // Don't send the pending changes prompt reply after approval
      } else if (pendingChanges && normalizedText === 'reject') {
        await safeSend(chatId, `🗑️ Changes discarded.`);
        return; // Don't send the pending changes prompt reply after rejection
      }

      if (pendingChanges) {
        // Send the pending changes prompt
        if (reply.length > 4000) {
          for (let i = 0; i < reply.length; i += 4000) {
            await safeSend(chatId, reply.slice(i, i + 4000));
          }
        } else {
          await safeSend(chatId, reply);
        }
        return; // Don't process further — user needs to approve/reject
      }

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
      const fileRes = await fetchWithTimeout(fileUrl, {}, 10000);
      if (!fileRes.ok) throw new Error('Failed to download voice file from Telegram.');
      const fileBuffer = await fileRes.arrayBuffer();

      // Validate that the file is actually an OGG container (magic bytes: "OggS")
      if (fileBuffer.byteLength < 4) {
        throw new Error('Voice file is too small to be valid.');
      }
      const header = new Uint8Array(fileBuffer.slice(0, 4));
      const magic = String.fromCharCode(...header);
      if (magic !== 'OggS') {
        throw new Error('Uploaded file is not a valid OGG audio file.');
      }

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

      const res = await fetchWithTimeout(apiUrl, { method: 'POST', headers, body: formData }, 30000);
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
