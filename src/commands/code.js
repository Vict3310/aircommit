import { requireSession, fetchFile, getDefaultBranch, getRepoFilePaths, applyAndCommit, applyAndCommitToBranch } from '../services/github.js';
import { callAI, callAIRaw } from '../services/ai.js';
import { MULTI_PATCH_PROMPT, FILES_PICKER_PROMPT, PR_DESCRIPTION_PROMPT } from '../core/prompts.js';
import { pendingActions, generateActionId } from '../core/pending.js';
import { uploadAuditLogTo0G } from '../services/zerog.js';
import { triggerBackgroundSync } from '../services/sync.js';
import config from '../core/config.js';
import { getUserSession } from '../services/supabase.js';
import { hasFeature, commandLimitMessage, premiumFeatureMessage } from '../services/subscription.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import solc from 'solc';
import child_process from 'child_process';
import util from 'util';

const exec = util.promisify(child_process.exec);

// ─── Subscription Gate Helper ───────────────────────────────────────────────

async function gatePremium(chatId, feature, minTier = null) {
  const session = await getUserSession(chatId);

  // Check subscription tier
  if (!hasFeature(session, feature)) {
    if (minTier) {
      return { allowed: false, message: premiumFeatureMessage() };
    }
    return { allowed: false, message: premiumFeatureMessage() };
  }

  // Check command limits
  const remaining = session._remainingCommands ?? -1;
  if (minTier && remaining !== undefined && remaining !== -1 && session.command_history) {
    const today = new Date().toDateString();
    const todayCount = (session.command_history || []).filter(c => new Date(c.timestamp).toDateString() === today).length;
    const tierConfig = { free: 10, starter: 50, pro: 200, team: -1 };
    const maxCmds = tierConfig[session.subscription_tier] || 10;
    if (todayCount >= maxCmds) {
      return { allowed: false, message: commandLimitMessage(0) };
    }
  }

  return { allowed: true, session };
}

async function verifyBuildSandbox(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `aircommit-val-${Date.now()}${ext}`);

  try {
    if (ext === '.js') {
      fs.writeFileSync(tmpFile, content, 'utf-8');
      try {
        await exec(`node --check ${tmpFile}`);
        return { status: 'PASSED', log: 'No syntax errors detected.' };
      } catch (err) {
        return { status: 'FAILED', log: err.message };
      }
    } else if (ext === '.json') {
      try {
        JSON.parse(content);
        return { status: 'PASSED', log: 'Valid JSON format.' };
      } catch (err) {
        return { status: 'FAILED', log: err.message };
      }
    } else if (ext === '.sol') {
      const filename = path.basename(filePath);
      const input = {
        language: 'Solidity',
        sources: { [filename]: { content } },
        settings: { outputSelection: { '*': { '*': ['abi'] } } }
      };
      const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
      if (compiled.errors && compiled.errors.some(e => e.severity === 'error')) {
        const errors = compiled.errors.filter(e => e.severity === 'error').map(e => e.message).join('\n');
        return { status: 'FAILED', log: errors };
      }
      return { status: 'PASSED', log: 'Solidity compiled successfully.' };
    }
    return { status: 'SKIPPED', log: `Sandbox checks skipped for ${ext} files.` };
  } catch (e) {
    return { status: 'ERROR', log: `Sandbox execution failed: ${e.message}` };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { }
  }
}

export function registerCodeCommands(bot, sendStatus) {
  bot.onText(/^\/fix\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].trim();

    // Check subscription
    const gate = await gatePremium(chatId, 'fix', 'pro');
    if (!gate.allowed) {
      return bot.sendMessage(chatId, gate.message);
    }

    const status = await sendStatus(chatId, '⏳ Connecting to pipelines...');

    try {
      const session = await requireSession(chatId);
      const { octokit, owner, repo, active_file } = session;

      let filePath, intent;
      const parts = input.split(' ');
      if ((parts[0].includes('.') || parts[0].includes('/')) && parts.length > 1) {
        filePath = parts[0];
        intent = parts.slice(1).join(' ');
      } else if (active_file) {
        filePath = active_file;
        intent = input;
      } else {
        throw new Error('Please specify a file path or /open a file first. Example: /fix src/app.js make it red');
      }

      const { content, sha } = await fetchFile(octokit, owner, repo, filePath);
      await status.update('⚙️ Generating patch...');
      const patch = await callAI(MULTI_PATCH_PROMPT, `File: ${filePath}\nContent:\n\`\`\`\n${content}\n\`\`\`\n\nInstruction: ${intent}`, undefined, chatId);
      if (!patch.patches || patch.patches.length === 0) throw new Error('AI returned no patches.');

      const actionId = generateActionId();
      pendingActions.set(actionId, {
        type: 'patch',
        octokit, owner, repo, filePath,
        content, sha,
        patch: patch.patches[0]
      });

      const keyboard = [
        [{ text: '✅ Approve & Commit', callback_data: `approve_action:${actionId}` }],
        [{ text: '❌ Reject', callback_data: `reject_action:${actionId}` }]
      ];

      await status.delete();
      const p = patch.patches[0];
      const diffPreview = `- ${p.find.trim()}\n+ ${p.replace.trim()}`;
      bot.sendMessage(chatId, `⚠️ *Pending Patch for \`${filePath}\`*\n\n\`\`\`diff\n${diffPreview}\n\`\`\`\n\n📝 _${patch.commitMessage}_`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (error) {
      await status.update(`❌ ${error.message}`);
    }
  });

  bot.onText(/^\/smart\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const intent = match[1];

    // Check subscription
    const gate = await gatePremium(chatId, 'smart', 'starter');
    if (!gate.allowed) {
      return bot.sendMessage(chatId, gate.message);
    }

    const status = await sendStatus(chatId, '🧠 Scanning repository...');

    try {
      const { octokit, owner, repo } = await requireSession(chatId);
      const defaultBranch = await getDefaultBranch(octokit, owner, repo);
      const filePaths = await getRepoFilePaths(octokit, owner, repo, defaultBranch);
      if (filePaths.length === 0) {
        await status.update('❌ No source files found.');
        return;
      }

      await status.update(`📂 Indexed ${filePaths.length} files. Identifying target files...`);

      const picker = await callAI(FILES_PICKER_PROMPT, `Repository files:\n${filePaths.join('\n')}\n\nInstruction: ${intent}`, undefined, chatId);
      if (!picker.filePaths || picker.filePaths.length === 0) {
        throw new Error('AI could not determine which files to edit.');
      }

      await status.update(`🎯 Targets: ${picker.filePaths.map(p => "\`" + p + "\`").join(', ')}\n_${picker.reasoning}_\n\n⚙️ Generating patches...`);

      const files = [];
      for (const path of picker.filePaths) {
        const { content, sha } = await fetchFile(octokit, owner, repo, path);
        files.push({ filePath: path, content, sha });
      }

      const filesContext = files.map(f => `File: ${f.filePath}\nContent:\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
      const result = await callAI(MULTI_PATCH_PROMPT, `${filesContext}\n\nInstruction: ${intent}`, undefined, chatId);

      if (!result.patches || result.patches.length === 0) {
        throw new Error('AI returned no patches.');
      }

      const actionId = generateActionId();
      pendingActions.set(actionId, {
        type: 'smart_patch',
        octokit, owner, repo, files,
        patches: result.patches,
        commitMessage: result.commitMessage
      });

      const keyboard = [
        [{ text: '✅ Approve & Commit All', callback_data: `approve_action:${actionId}` }],
        [{ text: '❌ Reject', callback_data: `reject_action:${actionId}` }]
      ];

      await status.delete();
      const diffPreview = result.patches.map(p => `📄 ${p.filePath}\n- ${p.find.trim()}\n+ ${p.replace.trim()}`).join('\n\n');
      bot.sendMessage(chatId, `⚠️ *Pending Smart Patches*\n\n\`\`\`diff\n${diffPreview.substring(0, 3000)}\n\`\`\`\n\n📝 _${result.commitMessage}_`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (error) {
      await status.update(`❌ ${error.message}`);
    }
  });

  bot.onText(/^\/pr\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].trim();

    // Check subscription
    const gate = await gatePremium(chatId, 'pr_review', 'pro');
    if (!gate.allowed) {
      return bot.sendMessage(chatId, gate.message);
    }

    const status = await sendStatus(chatId, '🌿 Spinning up Pull Request pipeline...');

    try {
      const { octokit, owner, repo } = await requireSession(chatId);
      const defaultBranch = await getDefaultBranch(octokit, owner, repo);
      let filePaths = [], intent;

      const parts = input.split(' ');
      const firstToken = parts[0];
      const looksLikeFilePath = firstToken.includes('.') || firstToken.includes('/');

      if (looksLikeFilePath && parts.length > 1) {
        filePaths = [firstToken];
        intent = parts.slice(1).join(' ');
      } else {
        await status.update('🧠 No file specified. Scanning repo to find files...');
        const allPaths = await getRepoFilePaths(octokit, owner, repo, defaultBranch);
        const picker = await callAI(FILES_PICKER_PROMPT, `Repository files:\n${allPaths.join('\n')}\n\nInstruction: ${input}`, undefined, chatId);
        if (!picker.filePaths || picker.filePaths.length === 0) {
          throw new Error('AI could not determine which files to edit.');
        }
        filePaths = picker.filePaths;
        intent = input;
        await status.update(`🎯 Targets: ${filePaths.map(p => "\`" + p + "\`").join(', ')}\n_${picker.reasoning}_`);
      }

      const branchSlug = intent.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-$/, '');
      const branchName = `aircommit/${branchSlug}`;

      const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
      const latestSha = refData.object.sha;

      await octokit.git.createRef({
        owner, repo,
        ref: `refs/heads/${branchName}`,
        sha: latestSha,
      });
      await status.update(`🌿 Branch created: \`${branchName}\`\n⚙️ Generating patches...`);

      const files = [];
      for (const path of filePaths) {
        const { content, sha } = await fetchFile(octokit, owner, repo, path);
        files.push({ filePath: path, content, sha });
      }

      const filesContext = files.map(f => `File: ${f.filePath}\nContent:\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
      const result = await callAI(MULTI_PATCH_PROMPT, `${filesContext}\n\nInstruction: ${intent}`);

      if (!result.patches || result.patches.length === 0) {
        throw new Error('AI returned no patches.');
      }

      await status.update(`🚀 Committing ${result.patches.length} patch(es) to branch \`${branchName}\`...`);
      for (const patch of result.patches) {
        const file = files.find(f => f.filePath === patch.filePath);
        if (!file) continue;
        await applyAndCommitToBranch(octokit, owner, repo, patch.filePath, file.content, file.sha, patch, branchName);
      }

      await status.update('📝 Generating Pull Request description...');
      const diffsSummary = result.patches.map(p => `File: ${p.filePath}\nDiff:\n- ${p.find.trim()}\n+ ${p.replace.trim()}`).join('\n\n');
      const prMeta = await callAI(PR_DESCRIPTION_PROMPT, `Instruction: ${intent}\n\nChanges:\n${diffsSummary}`);

      await status.update('🌿 Creating GitHub Pull Request...');
      const { data: prData } = await octokit.pulls.create({
        owner, repo,
        title: prMeta.title || result.commitMessage,
        body: prMeta.body || `Automated change by AirCommit.\n\n**Instruction:** ${intent}`,
        head: branchName,
        base: defaultBranch,
      });

      await status.update(`✅ *Pull Request Opened!*\n\n` +
        `📄 Files: ${filePaths.map(p => "\`" + p + "\`").join(', ')}\n` +
        `🌿 Branch: \`${branchName}\`\n` +
        `📝 Title: _${prMeta.title || result.commitMessage}_\n\n` +
        `👉 [Review & Merge PR #${prData.number}](${prData.html_url})`);

    } catch (error) {
      await status.update(`❌ ${error.message}`);
    }
  });

  bot.onText(/^\/create\s+(\S+)\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const filePath = match[1];
    const description = match[2];

    // Check subscription
    const gate = await gatePremium(chatId, 'fix', 'pro');
    if (!gate.allowed) {
      return bot.sendMessage(chatId, gate.message);
    }

    const status = await sendStatus(chatId, `🔨 Creating file \`${filePath}\`...`);
    try {
      const { octokit, owner, repo } = await requireSession(chatId);
      const content = await callAIRaw(
        `You are an expert developer. Create the full code for a new file named "${filePath}" based on the description. Return ONLY the raw file content. Do not include markdown code block formatting (like \`\`\`), conversational text, or explanations.`,
        `Description: ${description}`
      );

      const actionId = generateActionId();
      pendingActions.set(actionId, {
        type: 'create',
        octokit, owner, repo, filePath, content,
        commitMessage: `feat: create ${filePath}`
      });

      const keyboard = [
        [{ text: '✅ Approve & Commit', callback_data: `approve_action:${actionId}` }],
        [{ text: '❌ Reject', callback_data: `reject_action:${actionId}` }]
      ];

      await status.delete();
      bot.sendMessage(chatId, `⚠️ *Pending File Creation: \`${filePath}\`*\n\n\`\`\`\n${content.substring(0, 3000)}\n\`\`\``, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (error) {
      await status.update(`❌ Failed to create file: ${error.message}`);
    }
  });

  bot.onText(/^\/review(?:\s+(\S+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;

    try {
      const session = await requireSession(chatId);
      const filePath = match[1] || session.active_file;
      if (!filePath) throw new Error('Please specify a file path or /open a file first.');

      const status = await sendStatus(chatId, `🔍 Fetching and reviewing \`${filePath}\`...`);
      const { octokit, owner, repo } = session;
      const { content } = await fetchFile(octokit, owner, repo, filePath);
      const review = await callAIRaw(
        `You are an expert code reviewer. Analyze the code in the file. Check for:
1. Syntax & logical bugs
2. Security vulnerabilities
3. Performance issues or code smell
Provide a concise, constructive code review using markdown (bullet points). Focus on actionable feedback.`,
        `File: ${filePath}\n\nCode:\n${content}`
      );

      await status.delete();
      bot.sendMessage(chatId, `🔍 *Code Review for* \`${filePath}\`:\n\n${review}`, { parse_mode: 'Markdown' });
    } catch (error) {
      await status.update(`❌ Review failed: ${error.message}`);
    }
  });

  bot.onText(/^\/explain(?:\s+(\S+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;

    try {
      const session = await requireSession(chatId);
      const filePath = match[1] || session.active_file;
      if (!filePath) throw new Error('Please specify a file path or /open a file first.');

      const status = await sendStatus(chatId, `🧠 Analyzing \`${filePath}\`...`);
      const { octokit, owner, repo } = session;
      const { content } = await fetchFile(octokit, owner, repo, filePath);
      const explanation = await callAIRaw(
        `Provide a clear, high-level, and plain-English explanation of what this file does, its main functions, dependencies, and exports. Keep it brief and structured for mobile.`,
        `File: ${filePath}\n\nCode:\n${content}`
      );

      await status.delete();
      bot.sendMessage(chatId, `🧠 *Explanation for* \`${filePath}\`:\n\n${explanation}`, { parse_mode: 'Markdown' });
    } catch (error) {
      await status.update(`❌ Explanation failed: ${error.message}`);
    }
  });

  bot.onText(/^\/test(?:\s+(\S+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;

    // Check subscription
    const gate = await gatePremium(chatId, 'fix', 'pro');
    if (!gate.allowed) {
      return bot.sendMessage(chatId, gate.message);
    }

    try {
      const session = await requireSession(chatId);
      const filePath = match[1] || session.active_file;
      if (!filePath) throw new Error('Please specify a file path or /open a file first.');

      const status = await sendStatus(chatId, `🧪 Generating tests for \`${filePath}\`...`);
      const { octokit, owner, repo } = session;
      const { content } = await fetchFile(octokit, owner, repo, filePath);
      const result = await callAI(
        `You are a testing expert. Generate a comprehensive unit test suite for the provided file.
Return ONLY a valid JSON object matching this schema:
{
  "testFilePath": "path/to/testfile.test.js",
  "testContent": "raw test code here",
  "commitMessage": "commit message"
}`,
        `File: ${filePath}\n\nCode:\n${content}`
      );

      if (!result.testFilePath || !result.testContent) {
        throw new Error('AI returned incomplete test JSON.');
      }

      const testBase64 = Buffer.from(result.testContent).toString('base64');
      await octokit.repos.createOrUpdateFileContents({
        owner, repo,
        path: result.testFilePath,
        message: result.commitMessage || `test: add unit tests for ${filePath}`,
        content: testBase64,
      });

      await status.update(`✅ Created test file: \`${result.testFilePath}\``);
    } catch (error) {
      await status.update(`❌ Testing failed: ${error.message}`);
    }
  });

  bot.onText(/^\/rollback(?:\s+(\S+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;

    try {
      const session = await requireSession(chatId);
      const filePath = match[1] || session.active_file;
      if (!filePath) throw new Error('Please specify a file path or /open a file first.');

      const status = await sendStatus(chatId, `🔍 Fetching commit history for \`${filePath}\`...`);
      const { octokit, owner, repo } = session;
      const { data: commits } = await octokit.repos.listCommits({
        owner, repo,
        path: filePath,
        per_page: 5
      });

      if (commits.length === 0) {
        await status.update(`❌ No commits found for file: \`${filePath}\``);
        return;
      }

      const inlineKeyboard = commits.map(c => {
        const shortSha = c.sha.slice(0, 7);
        const msg = c.commit.message.split('\n')[0].slice(0, 30);
        return [{
          text: `${shortSha}: ${msg}`,
          callback_data: `rb:${filePath}:${c.sha}`
        }];
      });

      await status.delete();
      bot.sendMessage(chatId, `⏪ *Rollback File:* \`${filePath}\`\nSelect a commit to restore the file to:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: inlineKeyboard
        }
      });
    } catch (error) {
      await status.update(`❌ Error: ${error.message}`);
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('approve_action:')) {
      const actionId = data.split(':')[1];
      const action = pendingActions.get(actionId);
      if (!action) return bot.answerCallbackQuery(query.id, { text: 'Action expired or not found.' });

      bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
      const status = await sendStatus(chatId, `🚀 Committing approved changes...`);

      try {
        let successMsg = '';

        if (action.type === 'patch') {
          await applyAndCommit(action.octokit, action.owner, action.repo, action.filePath, action.content, action.sha, action.patch);
          successMsg = `✅ *Code Patched Live!*\n\n📄 File: \`${action.filePath}\`\n📝 Commit: _${action.patch.commitMessage}_`;
        } else if (action.type === 'smart_patch') {
          for (const patch of action.patches) {
            const file = action.files.find(f => f.filePath === patch.filePath);
            if (!file) continue;
            await applyAndCommit(action.octokit, action.owner, action.repo, patch.filePath, file.content, file.sha, patch);
          }
          successMsg = `✅ *Smart Patches Applied Live!*\n\n📝 Commit: _${action.commitMessage}_`;
        } else if (action.type === 'create') {
          const contentBase64 = Buffer.from(action.content).toString('base64');
          await action.octokit.repos.createOrUpdateFileContents({
            owner: action.owner, repo: action.repo,
            path: action.filePath,
            message: action.commitMessage,
            content: contentBase64,
          });
          successMsg = `✅ *File Created Live!*\n\n📄 File: \`${action.filePath}\``;
        }

        pendingActions.delete(actionId);

        try {
          const session = await requireSession(chatId);
          triggerBackgroundSync(chatId, action.owner, action.repo, session.github_token);
        } catch (_) { }

        // Run Build Sandbox Verification
        await status.update(`${successMsg}\n\n⚙️ _Verifying build sandbox..._`);
        let buildVerification = { status: 'SKIPPED', log: 'No file content to verify.' };
        try {
          if (action.type === 'patch') {
            // Reconstruct the new content from the patch find/replace
            const newContent = action.content.replace(action.patch.find, action.patch.replace);
            buildVerification = await verifyBuildSandbox(action.filePath, newContent);
          } else if (action.type === 'create') {
            buildVerification = await verifyBuildSandbox(action.filePath, action.content);
          }
        } catch (sandboxErr) {
          buildVerification = { status: 'ERROR', log: sandboxErr.message };
        }

        // Upload audit log to 0G decentralized storage
        await status.update(`${successMsg}\n\n🌐 _Uploading audit log to 0G..._`);
        try {
          const auditLog = {
            timestamp: new Date().toISOString(),
            type: action.type,
            repo: `${action.owner}/${action.repo}`,
            filePath: action.filePath || action.files?.map(f => f.filePath),
            commitMessage: action.patch?.commitMessage || action.commitMessage,
            aiPatch: action.type === 'patch' ? { find: action.patch?.find, replace: action.patch?.replace } : null,
            approvedByChatId: chatId,
            buildVerification, // Add build sandbox validation
          };
          const result = await uploadAuditLogTo0G(auditLog);
          if (result) {
            await status.update(
              `${successMsg}\n\n` +
              `⚙️ *Build Sandbox:* \`${buildVerification.status}\`\n` +
              `🌐 *0G Audit Trail*\n` +
              `🔐 Root Hash: \`${result.rootHash}\`\n` +
              `🔗 Tx: \`${result.txHash}\``
            );
          } else {
            await status.update(successMsg + '\n\n_ℹ️ 0G audit skipped (ZEROG\\_PRIVATE\\_KEY not set)_');
          }
        } catch (zerogErr) {
          console.error('0G upload error:', zerogErr.message);
          await status.update(successMsg + `\n\n⚠️ _0G audit upload failed: ${zerogErr.message}_`);
        }
      } catch (error) {
        await status.update(`❌ Commit failed: ${error.message}`);
      }
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('reject_action:')) {
      const actionId = data.split(':')[1];
      pendingActions.delete(actionId);
      bot.editMessageText(`❌ *Action Rejected*`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
      bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('menu_')) {
      const parts = data.split(':');
      const actionType = parts[0].replace('menu_', '');
      const filePath = parts.slice(1).join(':');

      let mockCommand = '';
      if (actionType === 'patch') mockCommand = `/fix ${filePath} please refactor or fix this`;
      else if (actionType === 'test') mockCommand = `/test ${filePath}`;
      else if (actionType === 'review') mockCommand = `/review ${filePath}`;
      else if (actionType === 'delete') {
        bot.answerCallbackQuery(query.id, { text: 'Starting deletion...' });
        bot.emit('message', { ...query.message, text: `delete the file ${filePath}` });
        return;
      }

      bot.answerCallbackQuery(query.id);
      bot.emit('message', { ...query.message, text: mockCommand });
      return;
    }

    if (data.startsWith('rb:')) {
      const [, filePath, sha] = data.split(':');
      await bot.answerCallbackQuery(query.id, { text: 'Starting rollback...' });

      const status = await sendStatus(chatId, `⏪ Rolling back \`${filePath}\` to commit \`${sha.slice(0, 7)}\`...`);
      try {
        const { octokit, owner, repo } = await requireSession(chatId);
        const { data: fileData } = await octokit.repos.getContent({
          owner, repo,
          path: filePath,
          ref: sha
        });

        if (Array.isArray(fileData) || fileData.type !== 'file') {
          throw new Error('Target path is not a file.');
        }

        const currentFile = await fetchFile(octokit, owner, repo, filePath);

        await octokit.repos.createOrUpdateFileContents({
          owner, repo,
          path: filePath,
          message: `rollback: restore ${filePath} to commit ${sha.slice(0, 7)}`,
          content: fileData.content,
          sha: currentFile.sha
        });

        await status.update(`✅ Successfully rolled back \`${filePath}\` to \`${sha.slice(0, 7)}\`!`);
      } catch (error) {
        await status.update(`❌ Rollback failed: ${error.message}`);
      }
    }
  });

  bot.onText(/^\/review-pr\s+(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const prNumber = parseInt(match[1]);

    // Check subscription
    const gate = await gatePremium(chatId, 'pr_review', 'pro');
    if (!gate.allowed) {
      return bot.sendMessage(chatId, gate.message);
    }

    const status = await sendStatus(chatId, `🔍 Fetching and reviewing PR #${prNumber}...`);
    try {
      const { octokit, owner, repo } = await requireSession(chatId);
      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
      const { data: diff } = await octokit.pulls.get({
        owner, repo,
        pull_number: prNumber,
        mediaType: { format: 'diff' },
      });

      const review = await callAIRaw(
        `You are an expert code reviewer. Review the following Pull Request diff. Summarize the changes, highlight potential bugs or code quality issues, and provide a clear verdict (Approve / Request Changes / Comment).`,
        `PR Title: ${pr.title}\nPR Body: ${pr.body}\n\nDiff:\n${diff}`
      );

      await status.delete();
      bot.sendMessage(chatId, `🔍 *PR #${prNumber} Review:* ${pr.title}\n\n${review}`, { parse_mode: 'Markdown' });
    } catch (error) {
      await status.update(`❌ PR review failed: ${error.message}`);
    }
  });

  bot.onText(/^\/view(?:\s+(\S+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;

    let status;
    try {
      const session = await requireSession(chatId);
      const filePath = match[1] || session.active_file;
      if (!filePath) throw new Error('Please specify a file path or /open a file first.');

      status = await sendStatus(chatId, `⏳ Fetching \`${filePath}\`...`);
      const { octokit, owner, repo } = session;
      const { content } = await fetchFile(octokit, owner, repo, filePath);
      let text = `📄 *${filePath}*\n\`\`\`\n${content}\n\`\`\``;
      if (text.length > 4000) text = text.substring(0, 3950) + '\n...[Truncated]```';

      const keyboard = [
        [
          { text: '✏️ Patch', callback_data: `menu_patch:${filePath}` },
          { text: '🧪 Test', callback_data: `menu_test:${filePath}` },
          { text: '🐞 Review', callback_data: `menu_review:${filePath}` }
        ],
        [
          { text: '🗑️ Delete', callback_data: `menu_delete:${filePath}` },
          { text: '🖥️ Open Editor', web_app: { url: `${config.baseUrl}/editor?file=${encodeURIComponent(filePath)}&chatId=${chatId}` } }
        ]
      ];

      await status.delete();
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    } catch (error) {
      if (error && error.status === 404) {
        await status.update(`❌ File not found: \`${filePath}\``);
      } else if (error) {
        await status.update(`❌ ${error.message}`);
      }
    }
  });
}
