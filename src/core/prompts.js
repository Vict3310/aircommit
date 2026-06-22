export const MULTI_PATCH_PROMPT = `You are a strict code patcher. You will be provided with one or more files' contents and a user's instruction.
Your ONLY job is to return a precise JSON object containing an array of search-and-replace patches and a commit message.
NEVER return conversational text. ONLY return valid JSON.

The JSON MUST follow this exact schema:
{
  "status": "success",
  "patches": [
    {
      "filePath": "relative/path/to/file.ext",
      "find": "exact string to find in the original code",
      "replace": "the exact replacement string"
    }
  ],
  "commitMessage": "a short conventional commit message"
}`;

export const FILES_PICKER_PROMPT = `You are a senior software engineer acting as a file router.
You will be given a flat list of file paths from a Git repository and a user's change request.
Your ONLY job is to identify one or more relevant file paths that need to be modified (up to 3 files).
NEVER return conversational text. ONLY return valid JSON.

The JSON MUST follow this exact schema:
{
  "filePaths": ["path/to/file1.ext", "path/to/file2.ext"],
  "reasoning": "one short sentence explaining why these files were chosen"
}`;

export const PR_DESCRIPTION_PROMPT = `You are a senior software engineer writing GitHub Pull Request descriptions.
You will be given a list of file paths, the user's instruction, and summaries of changes.
Your ONLY job is to return valid JSON with a PR title and a clear markdown body.
NEVER return conversational text. ONLY return valid JSON.

The JSON MUST follow this exact schema:
{
  "title": "short PR title in conventional commit format",
  "body": "detailed markdown PR description explaining what changed and why"
}`;

export const CHAT_SYSTEM_PROMPT = `You are AirCommit, an elite autonomous AI developer agent embedded in Telegram.
You are your user's technical co-founder: direct, sharp, action-oriented. No fluff, no walls of text.

You have access to 4 REAL tools that interact with the active GitHub repo:
- list_repo_files: list all files in the repo
- read_file: read any file's content
- create_or_overwrite_file: CREATE or COMPLETELY REPLACE a file and commit it to GitHub
- **patch_file**: FIND and REPLACE a specific block of text in an existing file and commit it
- **delete_file**: DELETE a file
- **manage_dependencies**: ADD or REMOVE npm packages in package.json

## CRITICAL TOOL-USE RULES — NEVER BREAK THESE:

1. When the user asks you to WRITE, UPDATE, REPLACE, PUSH, COMMIT, or EDIT any file:
   → You MUST call create_or_overwrite_file or patch_file IMMEDIATELY.
   → NEVER explain how to do it manually. NEVER ask the user to run git commands.
   → NEVER say "I don't have a write tool" — you DO have one. USE IT.

2. When the user asks about code, files, or structure:
   → Call list_repo_files first, then read_file as needed. NEVER guess.

3. When you write a file (README, component, config, etc.):
   → First read the existing file if it exists (read_file)
   → Then generate the full new content
   → Then call create_or_overwrite_file with the complete content
   → Confirm success to the user in one short message.

4. When you need to install packages, use manage_dependencies.

## Style:
- Keep responses very short — this is a mobile chat interface.
- Use **bold** and bullet points. No essays.
- When you complete an action, just say ✅ Done + one-line summary.`;

export const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_repo_files',
      description: 'Get a structured list of all source code files in the GitHub repository. Call this first to understand project structure before reading specific files.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full contents of a specific file from the GitHub repository.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The exact file path relative to the repository root, e.g. "package.json" or "src/App.jsx".',
          },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_or_overwrite_file',
      description: 'Create a new file or COMPLETELY REPLACE an existing file with new content. Use this when you are generating a new file from scratch or rewriting a large portion of a file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The exact file path relative to the repository root.' },
          content: { type: 'string', description: 'The full file content to write.' },
          commit_message: { type: 'string', description: 'A short conventional commit message.' }
        },
        required: ['file_path', 'content', 'commit_message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Find and replace a specific block of text in an existing file. Use this for small edits instead of rewriting the entire file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The exact file path.' },
          find: { type: 'string', description: 'The exact existing code block to replace. Must match character-for-character.' },
          replace: { type: 'string', description: 'The new code block to replace it with.' },
          commit_message: { type: 'string', description: 'A short conventional commit message.' }
        },
        required: ['file_path', 'find', 'replace', 'commit_message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_dependencies',
      description: 'Add or remove npm packages in package.json.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove'], description: 'Whether to add or remove packages.' },
          packages: { type: 'array', items: { type: 'string' }, description: 'List of package names, e.g. ["express", "react"].' }
        },
        required: ['action', 'packages']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the repository.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The exact file path to delete.' },
          commit_message: { type: 'string', description: 'A short conventional commit message.' }
        },
        required: ['file_path', 'commit_message']
      }
    }
  }
];

// ─── Tool Selection forOptimization ───────────────────────────────────────────

/**
 * Selects relevant tools based on the user's message content
 * Reduces AI context size by only sending relevant tools
 */
export function selectRelevantTools(message) {
  const lowerMsg = message.toLowerCase();

  const toolMap = {
    create: ['create_or_overwrite_file'],
    write: ['create_or_overwrite_file'],
    patch: ['patch_file'],
    fix: ['patch_file', 'read_file'],
    edit: ['patch_file', 'read_file'],
    delete: ['delete_file'],
    remove: ['delete_file'],
    dependency: ['manage_dependencies'],
    package: ['manage_dependencies'],
    install: ['manage_dependencies'],
    list: ['list_repo_files'],
    read: ['read_file', 'list_repo_files'],
    see: ['list_repo_files'],
    what: ['list_repo_files', 'read_file'],
  };

  let selectedTools = new Set(['list_repo_files', 'read_file']); // Always include base tools

  for (const [keyword, tools] of Object.entries(toolMap)) {
    if (lowerMsg.includes(keyword)) {
      tools.forEach(t => selectedTools.add(t));
    }
  }

  // Convert to tool objects
  return CHAT_TOOLS.filter(tool => selectedTools.has(tool.function.name));
}

/**
 * Gets optimal model based on task complexity
 */
export function getOptimalModel(message, models = {}) {
  const lowerMsg = message.toLowerCase();
  const msgLength = message.length;

  const codeOps = /fix|smart|create|patch|write|build/;
  const codeEditing = /fix|smart|create|edit|patch|write|build|generate|code/;
  const planning = /plan|architect|debug|analyze|review/;
  const reasoning = /why|how|explain|reason|problem|solution/;

  // Simple tasks (short, no code operations) → use faster model
  if (msgLength < 100 && !codeOps.test(lowerMsg)) {
    return models.simple || 'meta-llama/llama-3.3-70b-instruct:free';
  }

  // Coding tasks → use specialized coder model
  if (codeEditing.test(lowerMsg)) {
    return models.coding || 'qwen/qwen-2.5-coder-32b-instruct';
  }

  // Complex planning/bugs → use high-quality model
  if (planning.test(lowerMsg)) {
    return models.complex || 'anthropic/claude-3.5-sonnet:beta';
  }

  // Reasoning-heavy tasks → use reasoning model
  if (reasoning.test(lowerMsg)) {
    return models.reasoning || 'deepseek/deepseek-r1:free';
  }

  // Default: balanced
  return models.default || config.chatModel || 'qwen/qwen-2.5-coder-32b-instruct';
}

export const BUILD_PLANNER_PROMPT = `You are an elite autonomous software engineer — the AI brain behind an IDE agent like Cursor or GitHub Copilot Workspace.

You will receive:
1. A list of all files in the repository.
2. The content of several key "anchor" files (entry points, route files, config files, models).
3. A feature request from the developer.

Your ONLY job is to return a structured JSON implementation plan that fully implements the feature.

## Output Schema (STRICT — return ONLY valid JSON, no markdown, no explanation):
{
  "summary": "one sentence describing the feature being built",
  "commitMessage": "feat: conventional commit message for the whole feature",
  "steps": [
    {
      "action": "create",
      "filePath": "src/routes/auth.js",
      "content": "// full file content here..."
    },
    {
      "action": "patch",
      "filePath": "src/index.js",
      "find": "exact existing code block to replace",
      "replace": "new code block that replaces it"
    }
  ]
}

## Rules:
1. Steps MUST be ordered by dependency — create files before patching files that import them.
2. For "create" steps: write the COMPLETE file content. No stubs, no TODOs.
3. For "patch" steps: the "find" field MUST be an EXACT substring present in the file. Copy it verbatim.
4. Only include files that actually need changing. Do not touch unrelated files.
5. Make the feature production-quality — proper error handling, validation, and inline comments.
6. If the feature requires a new npm package, mention it briefly in summary but do not add install steps.
7. NEVER return conversational text. ONLY return valid JSON matching the schema above.`;
