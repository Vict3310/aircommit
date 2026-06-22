import fs from 'fs';
import path from 'path';
import os from 'os';
import child_process from 'child_process';
import util from 'util';
import crypto from 'crypto';

const exec = util.promisify(child_process.exec);

const REPO_BASE_DIR = path.join(os.tmpdir(), 'aircommit-repos');

// ─── Security Validation Helpers ──────────────────────────────────────────────

/**
 * Validates that a string contains only safe characters (alphanumeric, hyphen, underscore, dot)
 */
export function isValidIdentifier(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[a-zA-Z0-9_.-]+$/.test(str);
}

/**
 * Validates GitHub owner/repo format
 */
export function isValidGitHubPath(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(str);
}

/**
 * Validates branch name format
 */
export function isValidBranchName(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[a-zA-Z0-9_\/.-]+$/.test(str);
}

/**
 * Sanitizes git URL parameters to prevent injection
 */
export function sanitizeGitUrlParam(param) {
  if (!param) return '';
  return param.replace(/[^\w@.-]/g, '');
}

/**
 * Generates safe repo directory name from chatId/owner/repo
 */
export function getSafeRepoDirName(chatId, owner, repo) {
  const safeChatId = crypto.createHash('sha256').update(String(chatId)).digest('hex').substring(0, 16);
  const safeOwner = owner.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50);
  const safeRepo = repo.replace(/[^a-zA-Z0-9_.-]/g, '').substring(0, 50);
  return `${safeChatId}-${safeOwner}-${safeRepo}`;
}

/**
 * Ensures a synchronized local clone of the repository exists for the given chat session.
 * Re-uses existing clones to avoid downloading dependencies repeatedly.
 */
export async function getSyncedRepoPath(chatId, owner, repo, githubToken, defaultBranch = 'main') {
  // ─── Security Validation ───────────────────────────────────────────────────

  // Validate inputs are non-empty strings
  if (!chatId || !owner || !repo) {
    throw new Error('Invalid parameters: chatId, owner, and repo are required');
  }

  // Validate owner and repo format
  if (!isValidIdentifier(owner) || !isValidIdentifier(repo)) {
    throw new Error('Invalid repository identifier');
  }

  // Validate repo contains owner/repo format
  if (!isValidGitHubPath(`${owner}/${repo}`)) {
    throw new Error('Invalid repository format');
  }

  // Validate branch name
  if (!isValidBranchName(defaultBranch)) {
    throw new Error('Invalid branch name');
  }

  // Sanitize githubToken to prevent injection
  if (githubToken) {
    githubToken = sanitizeGitUrlParam(githubToken);
    if (!githubToken) {
      throw new Error('Invalid GitHub token');
    }
  }

  // ─── Build Safe Paths ─────────────────────────────────────────────────────

  if (!fs.existsSync(REPO_BASE_DIR)) {
    fs.mkdirSync(REPO_BASE_DIR, { recursive: true });
  }

  // Use hashed identifier to prevent path traversal and directory enumeration
  const repoDirName = getSafeRepoDirName(chatId, owner, repo);
  const repoPath = path.join(REPO_BASE_DIR, repoDirName);

  // Sanitize paths to prevent directory traversal
  const resolvedPath = path.resolve(repoPath);
  if (!resolvedPath.startsWith(path.resolve(REPO_BASE_DIR))) {
    throw new Error('Invalid repository path');
  }

  // Use safe git URL construction
  const cloneUrl = `https://${githubToken}@github.com/${owner}/${repo}.git`;

  // ─── Clone or Update Repository ────────────────────────────────────────────

  if (!fs.existsSync(repoPath)) {
    console.log(`[Sync] Cloning ${owner}/${repo} for chat ${chatId}...`);
    // Use shell-escaped command for git operations
    const safeCloneUrl = cloneUrl.replace(/'/g, "'\"'\"'");
    const safeRepoPath = repoPath.replace(/'/g, "'\"'\"'");
    await exec(`git clone '${safeCloneUrl}' '${safeRepoPath}'`, {
      shell: '/bin/bash',
      timeout: 120000 // 2 minute timeout for clone
    });

    // Install dependencies if present
    if (fs.existsSync(path.join(repoPath, 'package.json'))) {
      console.log(`[Sync] Installing dependencies for ${owner}/${repo}...`);
      await exec(`npm install --silent`, { cwd: repoPath, timeout: 300000 }); // 5 min timeout
    }
  } else {
    // If it exists, sync it
    console.log(`[Sync] Updating existing clone for ${owner}/${repo}...`);
    try {
      await exec(`git fetch origin`, { cwd: repoPath, timeout: 60000 });
      const safeBranch = defaultBranch.replace(/'/g, "'\"'\"'");
      await exec(`git reset --hard origin/'${safeBranch}'`, { cwd: repoPath, timeout: 60000 });
    } catch (e) {
      console.error(`[Sync] Failed to pull changes, falling back to clean clone: ${e.message}`);
      fs.rmSync(repoPath, { recursive: true, force: true });
      const safeCloneUrl = cloneUrl.replace(/'/g, "'\"'\"'");
      const safeRepoPath = repoPath.replace(/'/g, "'\"'\"'");
      await exec(`git clone '${safeCloneUrl}' '${safeRepoPath}'`, {
        shell: '/bin/bash',
        timeout: 120000
      });
      if (fs.existsSync(path.join(repoPath, 'package.json'))) {
        await exec(`npm install --silent`, { cwd: repoPath, timeout: 300000 });
      }
    }
  }

  return repoPath;
}

/**
 * Triggers a background sync. Can be called when the bot makes patches
 * or the user saves files, so the local repo is instantly updated.
 */
export function triggerBackgroundSync(chatId, owner, repo, githubToken, defaultBranch = 'main') {
  // Validates inputs before firing async operation
  if (!chatId || !owner || !repo) {
    console.error('[Sync Background] Invalid parameters, skipping sync');
    return;
  }

  // Fire and forget - errors are caught in getSyncedRepoPath
  getSyncedRepoPath(chatId, owner, repo, githubToken, defaultBranch).catch(err => {
    console.error(`[Sync Background Error] ${err.message}`);
  });
}
