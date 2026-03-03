import Anthropic from '@anthropic-ai/sdk';

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'write_file',
    description:
      'Create or update a file in the workspace. Use this to write code, config, text, images, or any file content. For binary files (images, PDFs, etc.), set encoding to "base64" and provide base64-encoded content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path (e.g., src/index.ts, README.md, logo.png)',
        },
        content: {
          type: 'string',
          description:
            'Full file content. For text files, provide raw text. For binary files, provide base64-encoded content.',
        },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description:
            'Content encoding. Use "utf-8" (default) for text files, "base64" for binary files (images, PDFs, etc.).',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Edit an existing file by replacing a specific string with new content. ' +
      'This is the preferred way to modify existing files — use it instead of write_file when making targeted changes. ' +
      'The old_string must match EXACTLY (including whitespace and indentation). ' +
      'Provide enough surrounding context in old_string to make the match unique.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path of the existing file to edit',
        },
        old_string: {
          type: 'string',
          description:
            'The exact string to find and replace. Must match the file content exactly, including whitespace and indentation. Include enough lines for a unique match.',
        },
        new_string: {
          type: 'string',
          description:
            'The replacement string. Can be empty to delete the matched text.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path to read',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path to delete',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List all files in the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];
