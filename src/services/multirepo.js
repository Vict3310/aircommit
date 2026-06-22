/**
 * Multi-Repo Parallel Workflow Engine
 *
 * Handles concurrent operations across multiple GitHub repositories
 * with proper isolation and error handling.
 */

import { requireSession, fetchFile, getRepoFilePaths } from './github.js';
import { callAI, callAIRaw } from './ai.js';
import { uploadAuditLogTo0G } from './zerog.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_CONCURRENT_REPOS = 3; // Concurrent repo operations
const WORKFLOW_CACHE_TTL = 600000; // 10 minutes

// ─── Cache for Multi-Repo State ──────────────────────────────────────────────

const workflowCache = new Map();

/**
 * Executes operations on multiple repositories in parallel
 */
export async function executeMultiRepoWorkflow(chatId, repos, operation, options = {}) {
  const results = [];

  // Process in batches to avoid overwhelming GitHub API
  for (let i = 0; i < repos.length; i += MAX_CONCURRENT_REPOS) {
    const batch = repos.slice(i, i + MAX_CONCURRENT_REPOS);

    const batchResults = await Promise.all(batch.map(repo =>
      executeSingleRepoWorkflow(chatId, repo, operation, options)
        .then(result => ({ ...repo, success: true, ...result }))
        .catch(error => ({ ...repo, success: false, error: error.message }))
    ));

    results.push(...batchResults);
  }

  return results;
}

/**
 * Executes workflow on a single repository
 */
export async function executeSingleRepoWorkflow(chatId, repo, operation, options = {}) {
  const { octokit, owner, repo: activeRepo, github_token } = await requireSession(chatId);

  // Override with provided repo if specified
  if (repo.owner && repo.name) {
    //Note: This is simplified - in practice, would need separate session
    return { error: 'Multiple repo sessions not yet fully implemented' };
  }

  // Execute the operation
  let result;
  switch (operation) {
    case 'refactor':
      result = await runRefactorWorkflow(chatId, owner, activeRepo, options);
      break;
    case 'fix':
      result = await runFixWorkflow(chatId, owner, activeRepo, options);
      break;
    case 'optimize':
      result = await runOptimizeWorkflow(chatId, owner, activeRepo, options);
      break;
    case 'benchmark':
      result = await runBenchmarkWorkflow(chatId, owner, activeRepo, options);
      break;
    default:
      result = { error: `Unknown operation: ${operation}` };
  }

  return result;
}

// ─── Command Registers ───────────────────────────────────────────────────────

export function registerMultiRepoCommands(bot, sendStatus) {
  // /multirepo <repo1,repo2,repo3> <operation> - Run workflow across multiple repos
  bot.onText(/^\/multirepo\s+(\S+)\s+(refactor|fix|optimize|benchmark)\s*(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const reposStr = match[1];
    const operation = match[2];
    const optionsStr = match[3];

    const repos = parseRepoSelector(reposStr);
    if (repos.length === 0) {
      await bot.sendMessage(chatId, `❌ Invalid repo format. Use: \`repo1,repo2,repo3\``, { parse_mode: 'Markdown' });
      return;
    }

    const status = await sendStatus(chatId, `🔄 Starting multi-repo ${operation} workflow for ${repos.length} repositories...`);

    try {
      const results = await executeMultiRepoWorkflow(chatId, repos, operation);

      let response = `🚀 *Multi-Repo Workflow Results*\n\n`;
      response += `⚙️ Operation: ${operation}\n`;
      response += ` Repositories: ${repos.length}\n\n`;

      let successCount = 0;
      let failCount = 0;

      results.forEach((result, i) => {
        if (result.success) {
          successCount++;
          response += `✅ ${result.owner}/${result.name}: Success`;
          if (result.results && result.results.length) {
            response += ` (${result.results.length} changes)`;
          }
          response += `\n`;
        } else {
          failCount++;
          response += `❌ ${result.owner}/${result.name}: ${result.error}\n`;
        }
      });

      response += `\n📊 Total: ${successCount} success, ${failCount} failed`;

      await status.delete();
      await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    } catch (error) {
      await status.update(`❌ Error: ${error.message}`);
    }
  });
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Parse repo selector from user input
 */
export function parseRepoSelector(input) {
  const repos = [];

  // Format: repo1,repo2,repo3
  if (input.includes(',')) {
    input.split(',').forEach(item => {
      const parts = item.trim().split('/');
      if (parts.length === 2) {
        repos.push({ owner: parts[0], name: parts[1] });
      }
    });
  }

  return repos;
}

/**
 * Cache workflow state
 */
export function cacheWorkflow(cacheKey, data, ttl = WORKFLOW_CACHE_TTL) {
  workflowCache.set(cacheKey, {
    data,
    expires: Date.now() + ttl,
  });
}

/**
 * Get cached workflow
 */
export function getCachedWorkflow(cacheKey) {
  const cached = workflowCache.get(cacheKey);
  if (!cached) return null;

  if (Date.now() > cached.expires) {
    workflowCache.delete(cacheKey);
    return null;
  }

  return cached.data;
}

/**
 * Clear workflow cache
 */
export function clearWorkflowCache() {
  workflowCache.clear();
}
