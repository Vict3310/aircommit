import { Octokit } from '@octokit/rest';
import { getUserSession } from './supabase.js';
import { createError, ValidationError, RepositoryError, AuthenticationError } from '../core/errors.js';
import { getCache, setCache, getFileTreeCache, setFileTreeCache, invalidateFileTreeCache } from './cache.js';

// ─── Parallel File Operations ────────────────────────────────────────────────

export async function requireSession(chatId) {
  const session = await getUserSession(chatId);
  if (!session || !session.github_token) {
    throw new AuthenticationError('You are not logged in. Use `/login` to connect your GitHub account.');
  }
  if (!session.active_repo) {
    throw new RepositoryError('No active repository set. Use `/repos` to list your repos and `/use <owner>/<repo>` to set one.');
  }
  return {
    octokit: new Octokit({ auth: session.github_token }),
    owner: session.active_owner,
    repo: session.active_repo,
    active_file: session.active_file || null,
    github_token: session.github_token
  };
}

export async function fetchFile(octokit, owner, repo, filePath) {
  const res = await octokit.repos.getContent({ owner, repo, path: filePath });
  const data = res.data;
  if (Array.isArray(data) || data.type !== 'file') {
    throw new ValidationError(`Path is not a file: ${filePath}`);
  }
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

/**
 * Fetches multiple files in parallel with rate limit handling
 */
export async function fetchFilesParallel(octokit, owner, repo, filePaths, maxConcurrent = 5) {
  const results = [];

  for (let i = 0; i < filePaths.length; i += maxConcurrent) {
    const batch = filePaths.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(batch.map(path =>
      fetchFile(octokit, owner, repo, path).catch(err => ({ error: err.message, path }))
    ));
    results.push(...batchResults);
  }

  return results;
}

export async function getDefaultBranch(octokit, owner, repo) {
  try {
    await octokit.git.getRef({ owner, repo, ref: 'heads/main' });
    return 'main';
  } catch {
    return 'master';
  }
}

const fileTreeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getRepoFilePaths(octokit, owner, repo, defaultBranch) {
  const cacheKey = `${owner}/${repo}:${defaultBranch}`;

  // Try Redis cache first (faster fallback)
  const redisCached = await getFileTreeCache(owner, repo, defaultBranch);
  if (redisCached) {
    return redisCached;
  }

  // Then memory cache
  const cached = fileTreeCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    // Also cache to Redis for other instances
    await setFileTreeCache(owner, repo, defaultBranch, cached.paths).catch(() => { });
    return cached.paths;
  }

  const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
  const { data: treeData } = await octokit.git.getTree({
    owner, repo,
    tree_sha: refData.object.sha,
    recursive: 'true',
  });

  const IGNORED_EXTS = ['.lock', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.ttf', '.eot', '.mp4', '.webp'];
  const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];

  const paths = treeData.tree
    .filter(item => item.type === 'blob')
    .map(item => item.path)
    .filter(p => !IGNORED_DIRS.some(d => p.startsWith(d + '/') || p.includes('/' + d + '/')))
    .filter(p => !IGNORED_EXTS.some(ext => p.endsWith(ext)));

  // Update both caches
  fileTreeCache.set(cacheKey, { paths, timestamp: Date.now() });
  await setFileTreeCache(owner, repo, defaultBranch, paths).catch(() => { });

  return paths;
}

export async function applyAndCommit(octokit, owner, repo, filePath, originalContent, sha, patch) {
  if (!originalContent.includes(patch.find)) {
    throw new Error(`AI's "find" string was not found in the file: ${filePath}`);
  }
  const updatedContent = originalContent.replace(patch.find, patch.replace);
  const updatedBase64 = Buffer.from(updatedContent).toString('base64');
  await octokit.repos.createOrUpdateFileContents({
    owner, repo,
    path: filePath,
    message: patch.commitMessage,
    content: updatedBase64,
    sha,
  });
  return updatedContent;
}

export async function applyAndCommitToBranch(octokit, owner, repo, filePath, originalContent, sha, patch, branch) {
  if (!originalContent.includes(patch.find)) {
    throw new Error(`AI's "find" string was not found in the file: ${filePath}`);
  }
  const updatedContent = originalContent.replace(patch.find, patch.replace);
  const updatedBase64 = Buffer.from(updatedContent).toString('base64');
  await octokit.repos.createOrUpdateFileContents({
    owner, repo,
    path: filePath,
    message: patch.commitMessage,
    content: updatedBase64,
    sha,
    branch,
  });
  return updatedContent;
}

export async function commitChangesWithTree(octokit, owner, repo, branch, commitMessage, changes) {
  const ref = `heads/${branch}`;
  const { data: refData } = await octokit.git.getRef({ owner, repo, ref });
  const latestCommitSha = refData.object.sha;

  const { data: commitData } = await octokit.git.getCommit({ owner, repo, commit_sha: latestCommitSha });
  const baseTreeSha = commitData.tree.sha;

  const tree = [];
  for (const change of changes) {
    if (change.action === 'delete') {
      tree.push({
        path: change.path,
        mode: '100644',
        type: 'blob',
        sha: null
      });
    } else if (change.action === 'create' || change.action === 'patch') {
      const { data: blobData } = await octokit.git.createBlob({
        owner, repo,
        content: Buffer.from(change.content).toString('base64'),
        encoding: 'base64'
      });
      tree.push({
        path: change.path,
        mode: '100644',
        type: 'blob',
        sha: blobData.sha
      });
    }
  }

  const { data: treeData } = await octokit.git.createTree({
    owner, repo,
    tree,
    base_tree: baseTreeSha
  });

  const { data: newCommitData } = await octokit.git.createCommit({
    owner, repo,
    message: commitMessage,
    tree: treeData.sha,
    parents: [latestCommitSha]
  });

  await octokit.git.updateRef({
    owner, repo,
    ref,
    sha: newCommitData.sha
  });

  return newCommitData.sha;
}

/**
 * Invalidates file tree cache for a repo when commits happen
 */
export async function invalidateFileTree(owner, repo) {
  await invalidateFileTreeCache(owner, repo);
  const regexPattern = new RegExp(`^${owner}/${repo}:.*$`);
  for (const key of fileTreeCache.keys()) {
    if (regexPattern.test(key)) {
      fileTreeCache.delete(key);
    }
  }
}
