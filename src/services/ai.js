import config from '../core/config.js';
import { CHAT_TOOLS, selectRelevantTools, getOptimalModel } from '../core/prompts.js';
import { requireSession, createWriteOctokit, fetchFile, getDefaultBranch, getRepoFilePaths, applyAndCommit, commitChangesWithTree, invalidateFileTree } from './github.js';
import { getUserSession, saveUserSession, decrypt } from './supabase.js';
import { uploadAuditLogTo0G } from './zerog.js';
import { sendStatusUpdate } from './websocket.js';
import { resolveAIKey } from './keys.js';
import { createGzip, createGunzip } from 'zlib';
import { fetchWithTimeout } from '../core/fetch-timeout.js';

const MAX_COMPRESS_LENGTH = 1000;
const MAX_TELEGRAM_MESSAGE = 4000;

// ─── Compression for Large Responses ──────────────────────────────────────────

export async function compressText(text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    createGzip()
      .on('data', chunk => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks).toString('base64')))
      .on('error', reject)
      .end(text);
  });
}

export async function decompressText(base64) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    createGunzip()
      .on('data', chunk => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', reject)
      .end(Buffer.from(base64, 'base64'));
  });
}

export async function compressLargeResponse(text) {
  if (text.length <= MAX_COMPRESS_LENGTH) {
    return { type: 'plain', content: text };
  }

  try {
    const compressed = await compressText(text);
    return {
      type: 'compressed',
      content: `data:${compressed}`,
      originalLength: text.length,
      compressedLength: compressed.length
    };
  } catch (e) {
    return { type: 'plain', content: text };
  }
}

/**
 * Resolves the correct API key and model for a given chatId.
 * - If the user has a saved BYOK key, decrypt and use it.
 * - If they have a saved model preference, use it.
 * - Otherwise fall back to server-level .env config.
 */
async function resolveUserAI(chatId, defaultModel) {
  if (!chatId) return { apiKey: config.openrouterKey, model: defaultModel, endpoint: 'https://openrouter.ai/api/v1/chat/completions' };
  try {
    const session = await getUserSession(chatId);
    const model = session?.selected_model || defaultModel;

    // Use the centralized key resolution from keys.js
    const resolved = await resolveAIKey(chatId, model, config);
    if (resolved) {
      return resolved;
    }

    // Fallback: try session-level custom OpenRouter key
    const apiKey = session?.custom_openrouter_key
      ? decrypt(session.custom_openrouter_key)
      : config.openrouterKey;
    return { apiKey, model, endpoint: 'https://openrouter.ai/api/v1/chat/completions' };
  } catch (_) {
    return { apiKey: config.openrouterKey, model: defaultModel, endpoint: 'https://openrouter.ai/api/v1/chat/completions' };
  }
}

export async function callAI(systemPrompt, userMessage, model = config.codingModel, chatId = null) {
  const { apiKey, model: resolvedModel, endpoint } = await resolveUserAI(chatId, model);
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 2000,
    }),
  }, 15000);

  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error('AI returned an invalid response. Please try again.');
  }
  if (!response.ok) {
    const errMsg = json?.error?.message || response.statusText;
    if (response.status === 429) {
      throw Object.assign(new Error(`Rate limited: ${errMsg}`), { rateLimited: true });
    }
    throw new Error(`OpenRouter API error: ${errMsg}`);
  }
  if (!json.choices || json.choices.length === 0) {
    throw new Error('OpenRouter returned no choices.');
  }

  const raw = json.choices[0].message.content;
  const cleaned = raw.replace(/^\`\`\`(?:json)?\n?/i, '').replace(/\n?\`\`\`$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error('AI returned invalid JSON. Please try again.');
  }
}

export async function callAIRaw(systemPrompt, userMessage, model = config.codingModel, chatId = null) {
  const { apiKey, model: resolvedModel, endpoint } = await resolveUserAI(chatId, model);
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 2000,
    }),
  }, 15000);

  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error('AI returned an invalid response. Please try again.');
  }
  if (!response.ok) {
    const errMsg = json?.error?.message || response.statusText;
    // Rate limit errors: add context so the fallback logic can decide
    if (response.status === 429) {
      throw Object.assign(new Error(`Rate limited: ${errMsg}`), { rateLimited: true });
    }
    throw new Error(`OpenRouter API error: ${errMsg}`);
  }
  return json.choices[0].message.content.replace(/^\`\`\`(?:[a-zA-Z0-9]+)?\n?/i, '').replace(/\n?\`\`\`$/i, '').trim();
}

const CHAT_MODEL_FALLBACKS = [
  config.chatModel,
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-coder:free',
];

async function tryOneChatRound(model, currentMessages, apiKey, endpoint) {
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: currentMessages,
      tools: CHAT_TOOLS,
      tool_choice: 'auto',
      max_tokens: 2000,
    }),
  }, 15000);

  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error(`Model ${model} returned an invalid response.`);
  }
  if (!response.ok) {
    const errMsg = json?.error?.message || response.statusText;
    if (response.status === 429) {
      throw Object.assign(new Error(`Rate limited: ${errMsg}`), { rateLimited: true });
    }
    throw new Error(`OpenRouter API error: ${errMsg}`);
  }
  if (!json.choices || json.choices.length === 0) {
    throw new Error(`Model ${model} returned no choices.`);
  }
  return json.choices[0].message;
}

export async function callChatWithTools(chatId, messages, onStatus = async () => { }, hasImage = false) {
  const MAX_ROUNDS = 12;
  let currentMessages = [...messages];

  // Resolve per-user API key and model preference
  const defaultModel = hasImage ? 'anthropic/claude-3.5-sonnet:beta' : config.chatModel;
  const { apiKey, model: preferredModel, endpoint } = await resolveUserAI(chatId, defaultModel);

  let activeModel = preferredModel;
  let activeEndpoint = endpoint;
  const fallbacks = hasImage
    ? ['google/gemini-pro-1.5']
    : [
      config.chatModel,
      'nvidia/nemotron-3-super-120b-a12b:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'qwen/qwen3-coder:free',
    ];

  let session;
  let readOnlyMode = false;
  try {
    session = await requireSession(chatId);
    readOnlyMode = session.read_only || false;
  } catch (e) {
    // Allow chat without session — tools will fail gracefully.
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let assistantMessage;
    let lastErr;

    try {
      for (const model of [activeModel, ...fallbacks]) {
        try {
          const currentEndpoint = (model === activeModel) ? activeEndpoint : 'https://openrouter.ai/api/v1/chat/completions';
          const currentApiKey = (model === activeModel) ? apiKey : config.openrouterKey;
          const actualModelName = model.startsWith('0g/') ? model.replace('0g/', '') : model;

          assistantMessage = await tryOneChatRound(actualModelName, currentMessages, currentApiKey, currentEndpoint);
          if (model !== activeModel) activeModel = model;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
        }
      }

      if (lastErr) throw lastErr;
    } catch (e) {
      // Unexpected error during the conversation loop — respond gracefully
      await onStatus(`❌ ${e.message}`);
      return {
        reply: `I encountered an unexpected error: ${e.message}. If it persists, please try again later.`,
        updatedMessages: currentMessages
      };
    }

    currentMessages.push(assistantMessage);

    // If the model returned no tool calls and a text reply, return it
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      let reply = assistantMessage.content || '(No response from model)';
      await onStatus('✍️ Writing response...');
      // Guard: strip raw tool-call JSON artifacts that models sometimes
      // output as plain text instead of invoking tools.
      if (/^\s*\{[^{}]*"type"\s*:\s*["\']function["\']/.test(reply)) {
        reply = 'I\'m sorry, I encountered an unexpected error. Please try again.';
      }
      return { reply, updatedMessages: currentMessages };
    }

    const treeChanges = [];
    const toolResults = [];

    for (const toolCall of assistantMessage.tool_calls) {
      const fnName = toolCall.function.name;
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch (parseErr) {
        toolResults.push({
          id: toolCall.id,
          result: `Tool call malformed — could not parse arguments: ${parseErr.message}. Please retry with valid JSON.`
        });
        continue;
      }
      let result;

      try {
        if (!session) {
          throw new Error("You must be logged in and select a repo to use tools. Tell the user to use /login and /use.");
        }
        const { octokit, owner, repo } = session;

        if (fnName === 'list_repo_files') {
          await onStatus('📂 Scanning repository file tree...');
          const filePaths = await getRepoFilePaths(octokit, owner, repo, await getDefaultBranch(octokit, owner, repo));
          result = `Repository: ${owner}/${repo}\n${filePaths.length} source files:\n${filePaths.join('\n')}`;
        } else if (fnName === 'read_file') {
          await onStatus(`📄 Reading \`${args.file_path}\`...`);
          const { content } = await fetchFile(octokit, owner, repo, args.file_path);
          result = content.length > 10000
            ? content.substring(0, 10000) + '\n\n...[file truncated at 10,000 chars]'
            : content;
        } else if (fnName === 'create_or_overwrite_file') {
          if (readOnlyMode) {
            result = `🔒 Read-only mode is ON. The \`create_or_overwrite_file\` tool is disabled. Tell the user to run \`/readonly off\` to enable writes.`;
            continue;
          }
          await onStatus(`✍️ Staging \`${args.file_path}\` for write...`);
          treeChanges.push({
            path: args.file_path,
            content: args.content,
            action: 'create',
            commitMessage: args.commit_message || `feat: write ${args.file_path}`
          });
          result = `Successfully staged ${args.file_path} for creation/overwrite.`;
        } else if (fnName === 'patch_file') {
          if (readOnlyMode) {
            result = `🔒 Read-only mode is ON. The \`patch_file\` tool is disabled. Tell the user to run \`/readonly off\` to enable writes.`;
            continue;
          }
          await onStatus(`⚙️ Staging \`${args.file_path}\` for patch...`);
          const { content: originalContent } = await fetchFile(octokit, owner, repo, args.file_path);

          let newContent = originalContent;
          if (originalContent.includes(args.find)) {
            newContent = originalContent.replace(args.find, args.replace);
          } else {
            const normalize = str => str.replace(/\r\n/g, '\n');
            const normalizedCurrent = normalize(originalContent);
            const normalizedFind = normalize(args.find);
            if (normalizedCurrent.includes(normalizedFind)) {
              newContent = normalizedCurrent.replace(normalizedFind, normalize(args.replace));
            } else {
              throw new Error(`The "find" text block was not found in the original file.`);
            }
          }

          treeChanges.push({
            path: args.file_path,
            content: newContent,
            action: 'patch',
            commitMessage: args.commit_message || `refactor: patch ${args.file_path}`
          });
          result = `Successfully staged ${args.file_path} for patching.`;
        } else if (fnName === 'delete_file') {
          if (readOnlyMode) {
            result = `🔒 Read-only mode is ON. The \`delete_file\` tool is disabled. Tell the user to run \`/readonly off\` to enable writes.`;
            continue;
          }
          await onStatus(`🗑️ Staging \`${args.file_path}\` for deletion...`);
          treeChanges.push({
            path: args.file_path,
            action: 'delete',
            commitMessage: args.commit_message || `chore: delete ${args.file_path}`
          });
          result = `Successfully staged ${args.file_path} for deletion.`;
        } else if (fnName === 'manage_dependencies') {
          if (readOnlyMode) {
            result = `🔒 Read-only mode is ON. The \`manage_dependencies\` tool is disabled. Tell the user to run \`/readonly off\` to enable writes.`;
            continue;
          }
          await onStatus(`📦 Staging dependencies: ${args.action} ${args.packages.join(', ')}...`);
          const { content: pkgJsonContent } = await fetchFile(octokit, owner, repo, 'package.json');
          const pkg = JSON.parse(pkgJsonContent);

          if (args.action === 'add') {
            pkg.dependencies = pkg.dependencies || {};
            for (const p of args.packages) {
              let res;
              try {
                res = await fetchWithTimeout(`https://registry.npmjs.org/${p}/latest`, {}, 5000);
              } catch {
                pkg.dependencies[p] = 'latest';
                continue;
              }
              if (res.ok) {
                try {
                  const data = await res.json();
                  if (data?.version) {
                    pkg.dependencies[p] = `^${data.version}`;
                  } else {
                    pkg.dependencies[p] = 'latest';
                  }
                } catch {
                  pkg.dependencies[p] = 'latest';
                }
              } else {
                pkg.dependencies[p] = 'latest';
              }
            }
          } else if (args.action === 'remove') {
            for (const p of args.packages) {
              if (pkg.dependencies) delete pkg.dependencies[p];
              if (pkg.devDependencies) delete pkg.devDependencies[p];
            }
          }

          const updatedContent = JSON.stringify(pkg, null, 2) + '\n';
          treeChanges.push({
            path: 'package.json',
            content: updatedContent,
            action: 'patch',
            commitMessage: `chore: ${args.action} dependencies ${args.packages.join(', ')}`
          });
          result = `Successfully staged package.json updates. User must run npm install locally.`;
        } else {
          // Fuzzy match: try to find closest known tool name
          // Normalize everything: lowercase, strip underscores/hyphens/dots, handle camelCase
          const knownTools = ['list_repo_files', 'read_file', 'create_or_overwrite_file', 'patch_file', 'delete_file', 'manage_dependencies'];
          const normalized = fnName.toLowerCase().replace(/[_\-\.]/g, '').replace(/([a-z])([A-Z])/g, '$1$2');
          let matched = false;
          for (const known of knownTools) {
            const knownNormalized = known.toLowerCase().replace(/[_\-\.]/g, '').replace(/([a-z])([A-Z])/g, '$1$2');
            if (normalized === knownNormalized || normalized.includes(knownNormalized) || knownNormalized.includes(normalized)) {
              // Hint the model to retry with the correct tool name
              result = `System: You called "${fnName}" but the correct tool name is "${known}". Please retry using "${known}" with the same arguments.`;
              matched = true;
              break;
            }
          }
          if (!matched) {
            result = `Unknown tool: ${fnName}. Available tools: ${knownTools.join(', ')}`;
          }
        }
      } catch (e) {
        result = `Error calling ${fnName}: ${e.message}`;
      }

      toolResults.push({ id: toolCall.id, result });
    }

    if (treeChanges.length > 0) {
      // Collect changes but don't auto-commit — return them for user approval
      await onStatus(`🌐 Staged ${treeChanges.length} changes — awaiting approval...`);
    }

    for (const { id, result } of toolResults) {
      if (id !== 'system_commit') {
        currentMessages.push({
          role: 'tool',
          tool_call_id: id,
          content: result,
        });
      } else {
        currentMessages.push({
          role: 'user',
          content: `System Warning: ${result}`
        });
      }
    }

    // If we have pending changes, return them with a prompt for approval
    if (treeChanges.length > 0) {
      const msg = treeChanges[0].commitMessage || 'Agentic modifications';
      const files = treeChanges.map(c => c.path).join(', ');
      return {
        reply: `🛠️ *${treeChanges.length} change(s) staged for \`${owner}/${repo}\`*\n\n📝 _${msg}_\n📂 Files: ${files}\n\nReply with \`approve\` to commit, or \`reject\` to discard.`,
        updatedMessages: currentMessages,
        pendingChanges: { repo: `${owner}/${repo}`, owner, repoName: repo, commitMessage: msg, changes: treeChanges, chatId }
      };
    }
  }

  throw new Error('Agent exceeded maximum tool rounds. Please try a more specific question.');
}
