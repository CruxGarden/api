export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate tool inputs before execution.
 * Catches malformed calls early with descriptive errors.
 */
export function validateToolInput(
  toolName: string,
  input: Record<string, any>,
): ValidationResult {
  switch (toolName) {
    case 'write_file':
      return validateWriteFile(input);
    case 'edit_file':
      return validateEditFile(input);
    case 'read_file':
    case 'delete_file':
      return validatePathOnly(input);
    case 'list_files':
      return { valid: true };
    default:
      return { valid: false, error: `Unknown tool: ${toolName}` };
  }
}

function validateWriteFile(input: Record<string, any>): ValidationResult {
  if (!input.path || typeof input.path !== 'string') {
    return { valid: false, error: 'path is required and must be a string.' };
  }
  if (input.content === undefined || input.content === null) {
    return { valid: false, error: 'content is required.' };
  }
  if (typeof input.content !== 'string') {
    return { valid: false, error: 'content must be a string.' };
  }

  const pathIssue = validatePath(input.path);
  if (pathIssue) return pathIssue;

  if (input.encoding && !['utf-8', 'base64'].includes(input.encoding)) {
    return {
      valid: false,
      error: `Invalid encoding "${input.encoding}". Use "utf-8" for text files or "base64" for binary files.`,
    };
  }

  return { valid: true };
}

function validateEditFile(input: Record<string, any>): ValidationResult {
  if (!input.path || typeof input.path !== 'string') {
    return { valid: false, error: 'path is required and must be a string.' };
  }
  if (typeof input.old_string !== 'string') {
    return {
      valid: false,
      error: 'old_string is required and must be a string.',
    };
  }
  if (typeof input.new_string !== 'string') {
    return {
      valid: false,
      error: 'new_string is required and must be a string.',
    };
  }
  if (input.old_string === input.new_string) {
    return {
      valid: false,
      error: 'old_string and new_string are identical. No change needed.',
    };
  }
  if (
    input.replace_all !== undefined &&
    typeof input.replace_all !== 'boolean'
  ) {
    return {
      valid: false,
      error: 'replace_all must be a boolean (true or false).',
    };
  }

  const pathIssue = validatePath(input.path);
  if (pathIssue) return pathIssue;

  return { valid: true };
}

function validatePathOnly(input: Record<string, any>): ValidationResult {
  if (!input.path || typeof input.path !== 'string') {
    return { valid: false, error: 'path is required and must be a string.' };
  }

  const pathIssue = validatePath(input.path);
  if (pathIssue) return pathIssue;

  return { valid: true };
}

function validatePath(path: string): ValidationResult | null {
  if (path.startsWith('/')) {
    const suggested = path.slice(1);
    return {
      valid: false,
      error: `Path "${path}" should not start with "/". Use relative paths like "${suggested}".`,
    };
  }
  if (path.includes('..')) {
    return {
      valid: false,
      error: 'Path must not contain ".." (directory traversal is not allowed).',
    };
  }
  if (path.includes('\\')) {
    return {
      valid: false,
      error: 'Use forward slashes "/" in paths, not backslashes "\\".',
    };
  }
  return null;
}
