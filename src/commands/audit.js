import { getSupabase } from '../services/supabase.js';
import { requireSession } from '../services/github.js';
import config from '../core/config.js';

export function registerAuditCommands(bot, sendStatus) {
  
  // /audit — show recent 0G audit trail entries for this repo from Supabase
  bot.onText(/^\/audit$/, async (msg) => {
    const chatId = msg.chat.id;
    const status = await sendStatus(chatId, '🔍 Fetching your 0G audit trail...');
    
    try {
      const supabase = getSupabase();
      if (!supabase) throw new Error('Supabase is required for audit logs.');

      const { owner, repo } = await requireSession(chatId);

      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('repo', `${owner}/${repo}`)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;
      if (!data || data.length === 0) {
        return status.update(`📋 No audit logs found for \`${owner}/${repo}\` yet.\n\nLogs are created every time you approve a patch with AirCommit.`);
      }

      const lines = data.map((log, i) => {
        const date = new Date(log.created_at).toLocaleString();
        const txShort = log.tx_hash ? `\`${log.tx_hash.slice(0, 16)}...\`` : '_none_';
        return `*${i + 1}.* \`${log.file_path || log.action_type}\`\n   📝 ${log.commit_message || 'N/A'}\n   🔗 0G Tx: ${txShort}\n   🕐 ${date}`;
      }).join('\n\n');

      await status.delete();
      bot.sendMessage(chatId, `📋 *Audit Trail for* \`${owner}/${repo}\`\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (e) {
      await status.update(`❌ ${e.message}`);
    }
  });

  // /report — hackathon-ready project summary
  bot.onText(/^\/report$/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
      let sessionInfo = '';
      try {
        const { owner, repo } = await requireSession(chatId);
        sessionInfo = `📁 Active Repo: \`${owner}/${repo}\``;
      } catch (_) {
        sessionInfo = '📁 Active Repo: _none (use /login then /repos)_';
      }

      const zerogEnabled = !!config.zerogPrivateKey;
      const supabaseEnabled = !!getSupabase();
      const ragEnabled = !!config.openaiApiKey;

      bot.sendMessage(chatId, 
        `🚀 *AirCommit — Zero Cup Hackathon Edition*\n\n` +
        `AirCommit is an autonomous AI engineering agent that lets any developer manage their GitHub repositories entirely from Telegram.\n\n` +
        `*🌐 0G Integration*\n` +
        `Every AI-authored commit is backed by a cryptographic audit log uploaded to the **0G Decentralized Storage Network**. This creates verifiable, tamper-proof provenance for all AI-generated code.\n\n` +
        `*⚡ Feature Status*\n` +
        `${zerogEnabled ? '✅' : '⚠️'} 0G Audit Storage ${zerogEnabled ? '(Active)' : '(Set ZEROG_PRIVATE_KEY)'}\n` +
        `${supabaseEnabled ? '✅' : '❌'} Supabase Sessions\n` +
        `${ragEnabled ? '✅' : '⚠️'} RAG Semantic Search ${ragEnabled ? '(Active)' : '(Set OPENAI_API_KEY)'}\n` +
        `✅ GitHub OAuth + PAT Auth\n` +
        `✅ AES-256 Token Encryption\n` +
        `✅ Commit Approval Flow (Diff Preview)\n` +
        `✅ Multimodal Image Support\n\n` +
        `${sessionInfo}\n\n` +
        `_Built for Zero Cup 2025 by AirCommit_`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(chatId, `❌ ${e.message}`);
    }
  });
}
