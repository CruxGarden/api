import Anthropic from '@anthropic-ai/sdk';

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'write_file',
    description:
      'Create a new file or completely replace an existing file in the workspace. ' +
      'USE WHEN: Creating new files, or rewriting a file where the majority of content changes. ' +
      'DO NOT USE WHEN: Making small targeted edits to existing files — use edit_file instead. ' +
      'NOTE: This will silently overwrite existing files. Check the workspace files list or call list_files first if unsure whether the file already exists. ' +
      'For binary files (images, fonts, PDFs), set encoding to "base64" and provide base64-encoded content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Relative file path from workspace root, without leading slash. Use forward slashes. Examples: "src/app.js", "styles/main.css", "index.html".',
        },
        content: {
          type: 'string',
          description:
            'Complete file content. For text files: provide raw text. For binary files (images, fonts, PDFs): provide base64-encoded content and set encoding to "base64".',
        },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description:
            'Content encoding. Default: "utf-8" for text files. Use "base64" for binary files (png, jpg, woff2, pdf, etc.).',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace a specific string in an existing file with new content. This is the PREFERRED way to modify files — use instead of write_file for targeted changes. ' +
      'PREREQUISITE: Always call read_file on this file immediately before calling edit_file. Never guess at file contents. ' +
      'The old_string must match EXACTLY one location in the file (including whitespace and indentation). ' +
      'FAILURE MODES: If old_string matches 0 times, the text does not exist — call read_file to check current contents. ' +
      'If old_string matches more than 1 time, include more surrounding lines to disambiguate.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Relative file path from workspace root, without leading slash. Example: "src/app.js".',
        },
        old_string: {
          type: 'string',
          description:
            'The exact string to find and replace. Must match file content exactly, including whitespace and indentation. Include 2-3 surrounding lines for uniqueness.',
        },
        new_string: {
          type: 'string',
          description:
            'The replacement string. Use empty string to delete the matched text.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read the contents of a file in the workspace. ' +
      'USE BEFORE: Every edit_file call — always read the file first to get its current contents. ' +
      'USE WHEN: You need to inspect file contents before making decisions or edits. ' +
      'RETURNS: Text content for text files, or base64-prefixed content for binary files (images, fonts, etc.).',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Relative file path from workspace root, without leading slash. Example: "src/app.js".',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_file',
    description:
      'Request deletion of a file from the workspace. ' +
      'IMPORTANT: This sends a confirmation request to the user — the file is NOT deleted immediately. The user must approve the deletion. ' +
      'Always confirm with the user in your message before calling this tool.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Relative file path from workspace root, without leading slash. Example: "src/old-file.js".',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description:
      'List all files currently in the workspace with their paths. ' +
      'NOTE: The current file list is already included in your system context at the bottom of this prompt. ' +
      'Only call this tool if you suspect files have changed since the conversation started (e.g., after write_file or delete_file operations in a previous turn).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];
