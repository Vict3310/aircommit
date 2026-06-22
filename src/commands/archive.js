import { chatHistories, saveHistories } from './chat.js';
import { uploadChatArchiveTo0G, downloadChatArchiveFrom0G } from '../services/zerog.js';
import { getSupabase, encrypt, decrypt } from '../services/supabase.js';
import config from '../core/config.js';

export function registerArchiveCommands(bot, sendStatus) {

  // /archive — Encrypt and save current conversation history to 0G
  bot.onText(/^\/archive$/, async (msg) => {
    const chatId = msg.chat.id;
    const status = await sendStatus(chatId, '🔒 Preparing and encrypting chat history...');

    try {
      if (!config.zerogPrivateKey) {
        throw new Error('ZEROG_PRIVATE_KEY is missing. Archiving requires a 0G wallet.');
      }

      const history = chatHistories.get(chatId);
      if (!history || history.length <= 1) {
        return status.update('ℹ️ Conversation history is empty. Send some messages first!');
      }

      // Convert history to string and encrypt it with our AES key
      const encryptedString = encrypt(JSON.stringify(history));
      const encryptedPayload = { encryptedData: encryptedString };

      await status.update('🌐 Uploading encrypted chat archive to 0G storage...');
      const result = await uploadChatArchiveTo0G(chatId, encryptedPayload);

      if (!result) {
        throw new Error('0G upload returned no response.');
      }

      await status.update(
        `✅ *Chat Session Decentralized!*\n\n` +
        `Chat history is now securely encrypted and saved on the 0G network.\n\n` +
        `🌐 *0G Archive Metadata*\n` +
        `🔐 Root Hash: \`${result.rootHash}\`\n` +
        `🔗 Tx Hash: \`${result.txHash}\`\n\n` +
        `To restore this chat history on any device, run:\n` +
        `\`/load_archive ${result.rootHash}\``
      );
    } catch (e) {
      await status.update(`❌ Archive failed: ${e.message}`);
    }
  });

  // /load_archive <root_hash> — Load and decrypt chat history from 0G
  bot.onText(/^\/load_archive\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const rootHash = match[1];
    const status = await sendStatus(chatId, '⏳ Downloading archive from 0G...');

    try {
      const encryptedPayload = await downloadChatArchiveFrom0G(rootHash);
      if (!encryptedPayload || !encryptedPayload.encryptedData) {
        throw new Error('Invalid archive structure retrieved.');
      }

      await status.update('🔐 Decrypting chat archive...');
      const decryptedString = decrypt(encryptedPayload.encryptedData);
      if (!decryptedString) {
        throw new Error('Decryption returned empty result. The archive may be corrupted or use a different encryption key.');
      }
      let history;
      try {
        history = JSON.parse(decryptedString);
      } catch (parseErr) {
        throw new Error(`Archive JSON is invalid: ${parseErr.message}`);
      }

      if (!Array.isArray(history)) {
        throw new Error('Retrieved archive does not contain a valid history array.');
      }

      // Set history
      chatHistories.set(chatId, history);
      saveHistories();

      await status.update(
        `✅ *Chat Session Restored!*\n\n` +
        `Successfully loaded \`${history.length}\` messages from the 0G Storage Network.\n\n` +
        `Type any message to continue your pair-programming session!`
      );
    } catch (e) {
      await status.update(`❌ Restore failed: ${e.message}`);
    }
  });
}
