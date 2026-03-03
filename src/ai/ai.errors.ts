/**
 * Format tool errors with actionable recovery guidance.
 * Instead of bare "Error: ..." strings, each error tells the model what to do next.
 */
export function formatToolError(
  toolName: string,
  error: Error | string,
): string {
  const message = typeof error === 'string' ? error : error.message;

  // Pattern-match common failures and provide recovery guidance
  const patterns: [RegExp, (groups: string[]) => string][] = [
    [
      /File not found: (.+)/i,
      (g) =>
        `File not found: ${g[1]}. Use list_files to see available files, or write_file to create it.`,
    ],
    [
      /old_string not found in (.+)/i,
      (g) =>
        `Edit failed: old_string not found in ${g[1]}. The file content may have changed. Call read_file to get the current contents, then retry edit_file with the exact text from the read.`,
    ],
    [
      /old_string matches (\d+) locations in (.+)/i,
      (g) =>
        `Edit failed: old_string matches ${g[1]} locations in ${g[2]}. Include more surrounding lines in old_string to create a unique match.`,
    ],
    [
      /Cannot edit binary file: (.+)/i,
      (g) =>
        `Cannot edit binary file: ${g[1]}. Binary files cannot be edited with edit_file. Use write_file with encoding "base64" to replace the entire file.`,
    ],
    [
      /max_tokens/i,
      () =>
        'Response was truncated (max_tokens reached). Try breaking the operation into smaller steps.',
    ],
    [
      /path .* should not start with/i,
      () => message, // validation errors already have guidance
    ],
    [/must not contain/i, () => message],
  ];

  for (const [pattern, formatter] of patterns) {
    const match = message.match(pattern);
    if (match) {
      return `Error: ${formatter(match)}`;
    }
  }

  // Default: generic but still helpful
  return `Error in ${toolName}: ${message}. Check the input parameters and try again.`;
}
