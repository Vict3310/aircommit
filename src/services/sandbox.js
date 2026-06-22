import child_process from 'child_process';
import util from 'util';
import path from 'path';
import os from 'os';

const exec = util.promisify(child_process.exec);

const DOCKER_IMAGE = 'node:20-alpine';
const TIMEOUT_MS = 30000;

// ─── Security Configuration ───────────────────────────────────────────────────

// Allowed commands - whitelist approach for safety
const ALLOWED_COMMANDS = new Set([
  'node', 'npm', 'npx', 'yarn', 'pnpm',
  'python', 'python3', 'pip', 'pip3',
  'java', 'javac',
  'go', 'go build', 'go run',
  'rustc', 'cargo',
  'gcc', 'g++', 'make', 'cmake',
  'bash', 'sh',
  'echo', 'cat', 'ls', 'pwd', 'which',
  'git', 'curl', 'wget'
]);

// Dangerous patterns that should never be allowed
const DANGEROUS_PATTERNS = [
  /;/g,           // Command chaining
  /&&/g,          // Logical AND
  /\|\|/g,        // Logical OR
  /\|/g,          // Pipe
  /`/g,           // Backtick execution
  /\$\(/g,        // $() execution
  /<\//g,         // File redirection from disk
  />\//g,         // File redirection to disk
  /&/g,           // Background execution
  /\n/g,          // Newline injection
  /\r/g,          // Carriage return
  /\.\./g,        // Directory traversal
  /\/etc\//g,      // System file access
  /\/root\//g,     // Root home access
  /\/proc\//g,     // Proc filesystem
  /\/dev\//g,      // Device access
  /rm\s+(-[a-zA-Z]*f|--force)?\s+\/\s*$/g,  // Dangerous rm /
  /mkfs/g,         // Format disk
  /dd\s/g,         // Disk dump
  /shutdown/g,     // Shutdown
  /reboot/g,       // Reboot
  /format/g,       // Format
  /wget.*\|.*sh/g, // Remote script execution
  /curl.*\|.*sh/g, // Remote script execution
];

// Allowed file extensions for source code
const ALLOWED_EXTENSIONS = new Set([
  '.js', '.ts', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.hpp', '.h',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.md', '.txt', '.sh', '.bash',
  '.html', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
  '.xml', '.properties', '.env',
  '.lock'
]);

// Command injection detection
function detectCommandInjection(cmd) {
  if (typeof cmd !== 'string') return { detected: false };

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return { detected: true, pattern: pattern.toString() };
    }
  }

  return { detected: false };
}

// Validate command is in allowed list
function validateAllowedCommand(cmd) {
  if (typeof cmd !== 'string') return false;

  const baseCmd = cmd.trim().split(/\s+/)[0];
  return ALLOWED_COMMANDS.has(baseCmd);
}

// Validate directory path
function validateRepoDir(repoDir) {
  if (typeof repoDir !== 'string') return { valid: false, error: 'Invalid repo directory' };

  // Resolve to absolute path
  const resolved = path.resolve(repoDir);

  // Ensure it's within allowed base directories
  const allowedRoots = [
    os.tmpdir(),
    path.join(os.homedir(), '.aircommit'),
    '/tmp',
    '/workspace'
  ];

  const isInAllowedRoot = allowedRoots.some(root => resolved.startsWith(root));
  if (!isInAllowedRoot) {
    return { valid: false, error: 'Repository directory outside allowed paths' };
  }

  // Check for path traversal
  if (resolved.includes('..') || resolved.includes('//')) {
    return { valid: false, error: 'Invalid directory path' };
  }

  return { valid: true, path: resolved };
}

/**
 * Executes a command safely inside an ephemeral Docker container.
 * The container is deleted immediately after execution.
 * @param {string} command The shell command to execute
 * @param {string} repoDir The absolute path to the synchronized local repository clone
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function executeInSandbox(command, repoDir) {
  // ─── Input Validation ──────────────────────────────────────────────────

  // Validate command
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { stdout: '', stderr: 'Error: Empty command' };
  }

  if (command.length > 500) {
    return { stdout: '', stderr: 'Error: Command too long (max 500 chars)' };
  }

  // Check for command injection
  const injectionCheck = detectCommandInjection(command);
  if (injectionCheck.detected) {
    console.warn('[Sandbox] Command injection detected and blocked:', injectionCheck.pattern);
    return { stdout: '', stderr: 'Error: Suspicious command pattern detected' };
  }

  // Validate allowed commands
  if (!validateAllowedCommand(command)) {
    return { stdout: '', stderr: 'Error: Command not allowed in sandbox' };
  }

  // Validate repository directory
  const dirValidation = validateRepoDir(repoDir);
  if (!dirValidation.valid) {
    return { stdout: '', stderr: `Error: ${dirValidation.error}` };
  }

  const safeRepoDir = dirValidation.path;

  // ─── Build Safe Docker Command ─────────────────────────────────────────

  // Use array form to avoid shell interpretation entirely
  const dockerArgs = [
    'run',
    '--rm',
    '--memory=512m',
    '--cpus=1.0',
    '--read-only',           // Read-only filesystem
    '--tmpfs=/tmp:rw,noexec,nosuid,size=128m',  // Temporary filesystem
    '--security=no-new-privileges',  // No privilege escalation
    `-v${safeRepoDir}:/workspace:ro`,  // Read-only mount of repo
    '-w', '/workspace',
    DOCKER_IMAGE,
    'sh', '-c', command    // Execute command inside container
  ];

  try {
    // Use spawn instead of exec to avoid shell interpretation
    return await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = child_process.spawn('docker', dockerArgs, {
        timeout: TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false  // CRITICAL: No shell interpretation
      });

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err) => {
        if (!timedOut) {
          resolve({
            stdout: stdout || '',
            stderr: stderr || `Docker error: ${err.message}`
          });
        }
      });

      child.on('exit', (code, signal) => {
        if (timedOut) return;

        if (code !== 0 && code !== null) {
          resolve({
            stdout: stdout || '',
            stderr: stderr || `Command exited with code ${code}`
          });
        } else {
          resolve({
            stdout: stdout || '',
            stderr: ''
          });
        }
      });

      // Timeout handling
      setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        resolve({
          stdout: stdout || '',
          stderr: 'Error: Command timed out (30s)'
        });
      }, TIMEOUT_MS);
    });
  } catch (err) {
    return {
      stdout: '',
      stderr: `Sandbox error: ${err.message}`
    };
  }
}

/**
 * Checks if a command is safe to run in the sandbox
 */
export function isCommandSafe(command) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { safe: false, reason: 'Empty command' };
  }

  const injectionCheck = detectCommandInjection(command);
  if (injectionCheck.detected) {
    return { safe: false, reason: 'Command injection detected' };
  }

  if (!validateAllowedCommand(command)) {
    return { safe: false, reason: 'Command not in allowlist' };
  }

  if (command.length > 500) {
    return { safe: false, reason: 'Command too long' };
  }

  return { safe: true };
}
