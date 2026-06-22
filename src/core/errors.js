// ─── Structured Error Classes ────────────────────────────────────────────────

/**
 * Base error class for all AirCommit errors
 */
export class AirCommitError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'AirCommitError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Authentication-related errors
 */
export class AuthenticationError extends AirCommitError {
  constructor(message = 'Authentication required', code = 'AUTH_REQUIRED') {
    super(message, code);
    this.name = 'AuthenticationError';
  }
}

/**
 * Authorization-related errors
 */
export class AuthorizationError extends AirCommitError {
  constructor(message = 'Insufficient permissions', code = 'AUTHZ_DENIED') {
    super(message, code);
    this.name = 'AuthorizationError';
  }
}

/**
 * Validation errors
 */
export class ValidationError extends AirCommitError {
  constructor(message = 'Invalid input', code = 'VALIDATION_FAILED') {
    super(message, code);
    this.name = 'ValidationError';
  }
}

/**
 * Repository-related errors
 */
export class RepositoryError extends AirCommitError {
  constructor(message = 'Repository error', code = 'REPO_ERROR') {
    super(message, code);
    this.name = 'RepositoryError';
  }
}

/**
 * GitHub API errors
 */
export class GitHubAPIError extends AirCommitError {
  constructor(message = 'GitHub API error', code = 'GITHUB_API_ERROR', statusCode = null) {
    super(message, code);
    this.name = 'GitHubAPIError';
    this.statusCode = statusCode;
  }
}

/**
 * AI/LLM service errors
 */
export class AIError extends AirCommitError {
  constructor(message = 'AI service error', code = 'AI_SERVICE_ERROR') {
    super(message, code);
    this.name = 'AIError';
  }
}

/**
 * File operation errors
 */
export class FileError extends AirCommitError {
  constructor(message = 'File operation error', code = 'FILE_ERROR') {
    super(message, code);
    this.name = 'FileError';
  }
}

/**
 * 0G Network errors
 */
export class ZeroGError extends AirCommitError {
  constructor(message = '0G network error', code = 'ZEROG_ERROR') {
    super(message, code);
    this.name = 'ZeroGError';
  }
}

/**
 * Supabase errors
 */
export class SupabaseError extends AirCommitError {
  constructor(message = 'Database error', code = 'SUPABASE_ERROR') {
    super(message, code);
    this.name = 'SupabaseError';
  }
}

// ─── Error Factory Functions ────────────────────────────────────────────────

/**
 * Factory function to create appropriate error based on context
 */
export function createError(error, context = {}) {
  if (error instanceof AirCommitError) {
    return error;
  }

  const message = error.message || String(error);
  const code = error.code || 'INTERNAL_ERROR';

  // GitHub API errors
  if (error.status || error.name === 'HttpError') {
    return new GitHubAPIError(message, code, error.status);
  }

  // File errors (check BEFORE generic error.code match)
  if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
    return new FileError(message, code);
  }

  // Supabase errors
  if (error?.message?.includes('supabase') || (error?.code && error?.details)) {
    return new SupabaseError(message, code);
  }

  // AI/LLM errors
  if (message.includes('OpenRouter') || message.includes('AI')) {
    return new AIError(message, code);
  }

  // 0G errors
  if (message.includes('0G') || message.includes('decentralized')) {
    return new ZeroGError(message, code);
  }

  // Validation errors
  if (context?.type === 'validation' || message.includes('Invalid')) {
    return new ValidationError(message, code);
  }

  // Default to generic error
  return new AirCommitError(message, code, context);
}

/**
 * Log error with context for debugging
 */
export function logError(error, context = {}) {
  const err = createError(error, context);

  console.error('[AirCommit Error]', {
    name: err.name,
    code: err.code,
    message: err.message,
    details: err.details,
    timestamp: err.timestamp,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  return err;
}

/**
 * Handle errors consistently across the application
 */
export function errorHandler(error, context = {}) {
  const err = logError(error, context);

  // Return appropriate response for Express routes
  if (context?.res) {
    const statusCode = getStatusCode(err.code);
    context.res.status(statusCode).json({
      error: err.name,
      code: err.code,
      message: err.message,
      details: process.env.NODE_ENV === 'development' ? err.details : undefined,
    });
  }

  return err;
}

/**
 * Map error codes to HTTP status codes
 */
export function getStatusCode(code) {
  const statusMap = {
    'AUTH_REQUIRED': 401,
    'AUTHZ_DENIED': 403,
    'VALIDATION_FAILED': 400,
    'REPO_ERROR': 404,
    'GITHUB_API_ERROR': 502,
    'AI_SERVICE_ERROR': 503,
    'FILE_ERROR': 500,
    'ZEROG_ERROR': 502,
    'SUPABASE_ERROR': 503,
    'INTERNAL_ERROR': 500,
  };
  return statusMap[code] || 500;
}

/**
 * Wrap async functions with error handling
 */
export function withErrorHandling(fn, context = {}) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      errorHandler(error, context);
      throw error;
    }
  };
}
