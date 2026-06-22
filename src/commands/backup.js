import { getSupabase } from '../services/supabase.js';
import { requireSession, fetchFile, getDefaultBranch, getRepoFilePaths } from '../services/github.js';
import { uploadBackupTo0G } from '../services/zerog.js';
import config from '../core/config.js';

export function registerBackupCommands(bot, sendStatus) {
  
  // /backup — downloads all repository source code files, packages them, and saves to 0G
  bot.onText(/^\/backup$/, async (msg) => {
    const chatId = msg.chat.id;
    const status = await sendStatus(chatId, '🔍 Scanning repository to prepare backup...');

    try {
      if (!config.zerogPrivateKey) {
        throw new Error('ZEROG_PRIVATE_KEY is missing. Backup feature requires a 0G wallet.');
      }

      const { octokit, owner, repo } = await requireSession(chatId);
      const defaultBranch = await getDefaultBranch(octokit, owner, repo);
      const filePaths = await getRepoFilePaths(octokit, owner, repo, defaultBranch);

      if (filePaths.length === 0) {
        throw new Error('No files found in the active repository to backup.');
      }

      await status.update(`⏳ Fetching all ${filePaths.length} codebase files...`);

      const bundledFiles = [];
      let loaded = 0;

      for (const filePath of filePaths) {
        try {
          const { content } = await fetchFile(octokit, owner, repo, filePath);
          bundledFiles.push({ path: filePath, content });
          loaded++;

          if (loaded % 10 === 0) {
            await status.update(`⏳ Loaded ${loaded}/${filePaths.length} files...`);
          }
        } catch (fileErr) {
          console.warn(`Could not read ${filePath} for backup:`, fileErr.message);
        }
      }

      await status.update(`🌐 Uploading backup snapshot to 0G storage...`);
      
      const result = await uploadBackupTo0G(chatId, `${owner}/${repo}`, bundledFiles);
      
      if (!result) {
        throw new Error('0G upload returned no response.');
      }

      await status.update(
        `✅ *Decentralized Backup Complete!*\n\n` +
        `📁 Repository: \`${owner}/${repo}\`\n` +
        `📦 Files Backed Up: \`${loaded}\`\n` +
        `🌐 *0G Storage Metadata*\n` +
        `🔐 Root Hash: \`${result.rootHash}\`\n` +
        `🔗 Tx Hash: \`${result.txHash}\`\n\n` +
        `Your codebase is now immutably saved on the decentralized 0G network.`
      );
    } catch (e) {
      await status.update(`❌ Backup failed: ${e.message}`);
    }
  });

  // /backups — lists previous 0G backups for this repository
  bot.onText(/^\/backups$/, async (msg) => {
    const chatId = msg.chat.id;
    const status = await sendStatus(chatId, '🔍 Fetching your backup snapshots...');

    try {
      const supabase = getSupabase();
      if (!supabase) throw new Error('Supabase is required to list backups.');

      const { owner, repo } = await requireSession(chatId);

      const { data, error } = await supabase
        .from('code_backups')
        .select('*')
        .eq('repo', `${owner}/${repo}`)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;
      if (!data || data.length === 0) {
        return status.update(`📋 No 0G backups found for \`${owner}/${repo}\` yet. Use \`/backup\` to create one.`);
      }

      const list = data.map((backup, i) => {
        const date = new Date(backup.created_at).toLocaleString();
        const rootShort = `${backup.root_hash.slice(0, 12)}...${backup.root_hash.slice(-12)}`;
        return `*${i + 1}.* 🔐 Root: \`${rootShort}\`\n   🔗 Tx: \`${backup.tx_hash.slice(0, 16)}...\`\n   🕐 ${date}`;
      }).join('\n\n');

      await status.delete();
      bot.sendMessage(chatId, `📋 *0G Backups for* \`${owner}/${repo}\`\n\n${list}`, { parse_mode: 'Markdown' });
    } catch (e) {
      await status.update(`❌ ${e.message}`);
    }
  });
}
