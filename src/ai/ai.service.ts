import { Injectable, NotFoundException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { LoggerService } from '../common/services/logger.service';
import { AttachmentService } from '../attachment/attachment.service';
import { AuthorService } from '../author/author.service';
import { CruxService } from '../crux/crux.service';
import { TOOL_DEFINITIONS } from './ai.tools';
import {
  buildSystemPrompt,
  estimateTokens,
  trimMessagesIfNeeded,
} from './ai.prompt';
import { formatToolError } from './ai.errors';
import { validateToolInput } from './ai.validation';
import { Response } from 'express';

interface StreamContext {
  cruxId: string;
  authorId: string;
  homeId: string;
  username: string;
  slug: string;
  res: Response;
  abortSignal?: AbortSignal;
}

@Injectable()
export class AiService {
  private readonly logger: LoggerService;

  constructor(
    private readonly loggerService: LoggerService,
    private readonly attachmentService: AttachmentService,
    private readonly authorService: AuthorService,
    private readonly cruxService: CruxService,
  ) {
    this.logger = this.loggerService.createChildLogger('AiService');
  }

  async streamChat(
    cruxId: string,
    messages: { role: 'user' | 'assistant'; content: unknown }[],
    model: string,
    authorId: string,
    res: Response,
    userApiKey: string,
  ): Promise<void> {
    // Load crux and its author for context
    const crux = await this.cruxService.findById(cruxId);
    if (!crux) throw new NotFoundException('Crux not found');
    const cruxAuthor = await this.authorService.findById(crux.authorId);

    const anthropicClient = new Anthropic({
      apiKey: userApiKey,
      maxRetries: 3,
    });

    // Abort controller for client disconnect propagation
    const abortController = new AbortController();
    let clientDisconnected = false;

    res.on('close', () => {
      clientDisconnected = true;
      abortController.abort();
      this.logger.info('Client disconnected, aborting stream');
    });

    const ctx: StreamContext = {
      cruxId,
      authorId,
      homeId: crux.homeId,
      username: cruxAuthor.username,
      slug: crux.slug,
      res,
      abortSignal: abortController.signal,
    };

    // Set SSE headers early so all errors go through SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      // Build system prompt (includes current file listing)
      const systemPrompt = await buildSystemPrompt(crux, () =>
        this.toolListFiles(ctx),
      );

      // Pass messages through — content may be string or content blocks
      let anthropicMessages = messages as Anthropic.MessageParam[];

      // Trim conversation if it exceeds the context window
      const systemTokens = estimateTokens(systemPrompt);
      const trimResult = trimMessagesIfNeeded(
        anthropicMessages,
        systemTokens,
        model,
      );
      if (trimResult.trimmed) {
        anthropicMessages = trimResult.messages;
        this.logger.warn('Trimmed conversation history to fit context window', {
          originalCount: messages.length,
          trimmedCount: anthropicMessages.length,
        });
        this.sendSSE(res, 'info', {
          message: 'Older messages were trimmed to fit the context window.',
        });
      }

      this.logger.info('Starting conversation loop', {
        model,
        messageCount: anthropicMessages.length,
        systemPromptLength: systemPrompt.length,
      });

      await this.runConversationLoop(
        systemPrompt,
        anthropicMessages,
        model,
        ctx,
        anthropicClient,
        crux,
      );
    } catch (error: any) {
      if (clientDisconnected) return;
      const message =
        error.message || error.toString() || 'Unknown stream error';
      this.logger.error(
        `Stream error [${error.constructor?.name}]: ${message}`,
      );
      this.sendSSE(res, 'error', { message });
    } finally {
      if (!clientDisconnected) {
        this.sendSSE(res, 'done', {});
        res.end();
      }
    }
  }

  private async runConversationLoop(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    model: string,
    ctx: StreamContext,
    anthropicClient: Anthropic,
    crux: any,
  ): Promise<void> {
    const MAX_TOOL_ROUNDS = 10;
    let currentSystemPrompt = systemPrompt;
    const recentlyReadFiles = new Set<string>();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Stream response with error classification
      let response: {
        stopReason: string;
        toolCalls: { id: string; name: string; input: any }[];
        contentBlocks: Anthropic.ContentBlock[];
      };

      try {
        response = await this.streamResponse(
          currentSystemPrompt,
          messages,
          model,
          ctx,
          anthropicClient,
        );
      } catch (error: any) {
        // Client disconnected — stop silently
        if (ctx.abortSignal?.aborted) return;

        // Anthropic rate limit or overload that survived SDK retries
        if (error.status === 429 || error.status === 529) {
          this.sendSSE(ctx.res, 'error', {
            message:
              'The AI service is temporarily overloaded. Please try again in a moment.',
          });
          return;
        }

        throw error;
      }

      // If no tool use, we're done
      if (response.stopReason !== 'tool_use') break;

      // Process tool calls — parallel across independent path groups
      const groups = this.groupToolCallsByPath(response.toolCalls);
      const chainResults = await Promise.all(
        [...groups.values()].map((chain) =>
          this.executeToolChain(chain, ctx, recentlyReadFiles),
        ),
      );

      // Aggregate results: reassemble in original order, merge mutation flags
      let hadFileMutation = false;
      const resultMap = new Map<string, string>();
      for (const cr of chainResults) {
        if (cr.hadMutation) hadFileMutation = true;
        for (const r of cr.results) resultMap.set(r.toolId, r.content);
      }

      const toolResults: Anthropic.ToolResultBlockParam[] =
        response.toolCalls.map((tc) => ({
          type: 'tool_result' as const,
          tool_use_id: tc.id,
          content: resultMap.get(tc.id) || 'Error: no result',
        }));

      // Add assistant response + tool results to messages for next round
      messages.push({
        role: 'assistant',
        content: response.contentBlocks,
      });
      messages.push({
        role: 'user',
        content: toolResults,
      });

      // Refresh system prompt with updated file list after mutations
      if (hadFileMutation) {
        currentSystemPrompt = await buildSystemPrompt(crux, () =>
          this.toolListFiles(ctx),
        );
      }
    }
  }

  private async streamResponse(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    model: string,
    ctx: StreamContext,
    anthropicClient: Anthropic,
  ): Promise<{
    stopReason: string;
    toolCalls: { id: string; name: string; input: any }[];
    contentBlocks: Anthropic.ContentBlock[];
  }> {
    const stream = anthropicClient.messages.stream(
      {
        model,
        max_tokens: 16384,
        system: systemPrompt,
        messages,
        tools: TOOL_DEFINITIONS,
      },
      {
        signal: ctx.abortSignal,
      },
    );

    const toolCalls: { id: string; name: string; input: any }[] = [];
    const contentBlocks: Anthropic.ContentBlock[] = [];

    stream.on('text', (text) => {
      this.sendSSE(ctx.res, 'text', { content: text });
    });

    const finalMessage = await stream.finalMessage();

    for (const block of finalMessage.content) {
      contentBlocks.push(block);
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }

    // If response was truncated, surface it as an error so the user knows
    if (
      finalMessage.stop_reason === 'max_tokens' &&
      toolCalls.length === 0 &&
      contentBlocks.length === 0
    ) {
      throw new Error(
        'Response was truncated (max_tokens reached with no usable content). The file may be too large for a single operation.',
      );
    }

    return {
      stopReason: finalMessage.stop_reason,
      toolCalls,
      contentBlocks,
    };
  }

  /**
   * Group tool calls by file path so same-path operations stay sequential
   * while different-path operations can run in parallel.
   */
  private groupToolCallsByPath(
    toolCalls: { id: string; name: string; input: any }[],
  ): Map<string, { id: string; name: string; input: any }[]> {
    const groups = new Map<
      string,
      { id: string; name: string; input: any }[]
    >();

    for (const tc of toolCalls) {
      const path = tc.input?.path;
      // Tools without a path (list_files) get their own independent group
      const key = path ? path.replace(/^\//, '') : `__no_path_${tc.id}`;
      const group = groups.get(key) || [];
      group.push(tc);
      groups.set(key, group);
    }

    return groups;
  }

  /**
   * Execute a chain of tool calls sequentially (they share a file path).
   * Sends SSE events for each tool and tracks read/mutation state.
   */
  private async executeToolChain(
    chain: { id: string; name: string; input: any }[],
    ctx: StreamContext,
    recentlyReadFiles: Set<string>,
  ): Promise<{
    results: { toolId: string; content: string }[];
    hadMutation: boolean;
  }> {
    const results: { toolId: string; content: string }[] = [];
    let hadMutation = false;

    for (const toolUse of chain) {
      this.sendSSE(ctx.res, 'tool_start', {
        name: toolUse.name,
        id: toolUse.id,
        input: toolUse.input,
      });

      // Track read_file calls for read-before-edit advisory
      if (toolUse.name === 'read_file' && toolUse.input.path) {
        recentlyReadFiles.add(toolUse.input.path);
        recentlyReadFiles.add(toolUse.input.path.replace(/^\//, ''));
      }

      let result = await this.executeTool(toolUse, ctx);

      // Advisory: warn if edit_file was called without a preceding read_file
      if (
        toolUse.name === 'edit_file' &&
        toolUse.input.path &&
        !recentlyReadFiles.has(toolUse.input.path) &&
        !recentlyReadFiles.has(toolUse.input.path.replace(/^\//, ''))
      ) {
        result =
          'Note: This file was edited without a preceding read_file. If the edit failed, read the file first to get current contents.\n' +
          result;
      }

      // Clear read tracking for mutated files (content changed, stale)
      if (toolUse.name === 'write_file' || toolUse.name === 'edit_file') {
        recentlyReadFiles.delete(toolUse.input.path);
        recentlyReadFiles.delete(toolUse.input.path?.replace(/^\//, ''));
      }

      // Track file mutations for system prompt refresh
      if (['write_file', 'edit_file', 'delete_file'].includes(toolUse.name)) {
        hadMutation = true;
      }

      this.sendSSE(ctx.res, 'tool_result', {
        name: toolUse.name,
        id: toolUse.id,
        result,
      });

      results.push({ toolId: toolUse.id, content: result });
    }

    return { results, hadMutation };
  }

  private async executeTool(
    toolUse: { id: string; name: string; input: any },
    ctx: StreamContext,
  ): Promise<string> {
    // Validate inputs before execution
    const validation = validateToolInput(toolUse.name, toolUse.input);
    if (!validation.valid) {
      return formatToolError(toolUse.name, validation.error!);
    }

    try {
      switch (toolUse.name) {
        case 'write_file':
          return await this.toolWriteFile(
            toolUse.input.path,
            toolUse.input.content,
            ctx,
            toolUse.input.encoding,
          );
        case 'edit_file':
          return await this.toolEditFile(
            toolUse.input.path,
            toolUse.input.old_string,
            toolUse.input.new_string,
            ctx,
          );
        case 'read_file':
          return await this.toolReadFile(toolUse.input.path, ctx);
        case 'delete_file':
          return await this.toolDeleteFile(toolUse.input.path, ctx);
        case 'list_files':
          return await this.toolListFiles(ctx);
        default:
          return formatToolError(toolUse.name, `Unknown tool: ${toolUse.name}`);
      }
    } catch (error: any) {
      return formatToolError(toolUse.name, error);
    }
  }

  private async toolWriteFile(
    path: string,
    content: string,
    ctx: StreamContext,
    encoding: 'utf-8' | 'base64' = 'utf-8',
  ): Promise<string> {
    // Check if file already exists
    const existing = await this.findAttachmentByPath(path, ctx.cruxId);

    const buffer = Buffer.from(content, encoding);
    const ext = path.split('.').pop() || 'txt';
    const mimeType = this.getMimeType(ext);

    const filename = path.split('/').pop() || 'file';
    const file = {
      fieldname: 'file',
      originalname: filename,
      encoding: encoding === 'base64' ? 'base64' : '7bit',
      mimetype: mimeType,
      buffer,
      size: buffer.length,
    };

    if (existing) {
      await this.attachmentService.updateWithFile(
        existing.id,
        { meta: JSON.stringify({ path }) },
        file,
      );
      return `Updated file: ${path}`;
    } else {
      await this.attachmentService.createWithFile(
        'crux',
        ctx.cruxId,
        ctx.homeId,
        ctx.authorId,
        { type: 'file', kind: 'artifact', meta: JSON.stringify({ path }) },
        file,
      );
      return `Created file: ${path}`;
    }
  }

  private async toolEditFile(
    path: string,
    oldString: string,
    newString: string,
    ctx: StreamContext,
  ): Promise<string> {
    const attachment = await this.findAttachmentByPath(path, ctx.cruxId);
    if (!attachment) {
      return formatToolError('edit_file', `File not found: ${path}`);
    }

    const { data, mimeType } = await this.attachmentService.downloadAttachment(
      attachment.id,
    );

    if (this.isBinaryMime(mimeType)) {
      return formatToolError('edit_file', `Cannot edit binary file: ${path}`);
    }

    const currentContent = data.toString('utf-8');
    const matchCount = currentContent.split(oldString).length - 1;

    if (matchCount === 0) {
      return formatToolError('edit_file', `old_string not found in ${path}`);
    }
    if (matchCount > 1) {
      return formatToolError(
        'edit_file',
        `old_string matches ${matchCount} locations in ${path}`,
      );
    }

    // Use a replacer function to avoid $ pattern interpretation in newString
    const updatedContent = currentContent.replace(oldString, () => newString);

    const buffer = Buffer.from(updatedContent, 'utf-8');
    const filename = path.split('/').pop() || 'file';

    await this.attachmentService.updateWithFile(
      attachment.id,
      { meta: JSON.stringify({ path }) },
      {
        fieldname: 'file',
        originalname: filename,
        encoding: '7bit',
        mimetype: mimeType,
        buffer,
        size: buffer.length,
      },
    );

    return `Edited file: ${path}`;
  }

  private async toolDeleteFile(
    path: string,
    ctx: StreamContext,
  ): Promise<string> {
    const attachment = await this.findAttachmentByPath(path, ctx.cruxId);
    if (!attachment) {
      return formatToolError('delete_file', `File not found: ${path}`);
    }

    // Don't delete immediately — send a pending event so the frontend can ask for confirmation
    this.sendSSE(ctx.res, 'delete_request', {
      attachmentId: attachment.id,
      path,
    });

    return `Requested deletion of ${path}. The user will be asked to confirm.`;
  }

  private async toolReadFile(
    path: string,
    ctx: StreamContext,
  ): Promise<string> {
    const attachment = await this.findAttachmentByPath(path, ctx.cruxId);
    if (!attachment) {
      return formatToolError('read_file', `File not found: ${path}`);
    }

    const { data, mimeType } = await this.attachmentService.downloadAttachment(
      attachment.id,
    );

    if (this.isBinaryMime(mimeType)) {
      return `[Binary file: ${path} (${mimeType}, ${data.length} bytes)] base64:${data.toString('base64')}`;
    }

    return data.toString('utf-8');
  }

  private isBinaryMime(mimeType: string): boolean {
    if (mimeType.startsWith('text/')) return false;
    if (mimeType === 'application/json') return false;
    if (mimeType === 'application/javascript') return false;
    if (mimeType === 'image/svg+xml') return false;
    return true;
  }

  private async toolListFiles(ctx: StreamContext): Promise<string> {
    const attachments = await this.attachmentService.findByResource(
      'crux',
      ctx.cruxId,
    );

    if (attachments.length === 0) return 'No files in workspace.';

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    return attachments
      .map((a) => {
        const path = a.meta?.path || a.filename || a.id;
        const url = `${baseUrl}/authors/@${ctx.username}/cruxes/${ctx.cruxId}/attachments/${a.id}/download`;
        return `${path} → ${url}`;
      })
      .join('\n');
  }

  private async findAttachmentByPath(
    path: string,
    cruxId: string,
  ): Promise<any | null> {
    const attachments = await this.attachmentService.findByResource(
      'crux',
      cruxId,
    );
    // Match by meta.path first, then fall back to filename (for user-uploaded files)
    const normalized = path.replace(/^\//, '');
    return (
      attachments.find(
        (a) =>
          a.meta?.path === path ||
          a.meta?.path === normalized ||
          a.filename === path ||
          a.filename === normalized,
      ) || null
    );
  }

  private sendSSE(res: Response, event: string, data: any): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private getMimeType(ext: string): string {
    const types: Record<string, string> = {
      // Text / code
      ts: 'text/typescript',
      tsx: 'text/typescript',
      js: 'application/javascript',
      jsx: 'application/javascript',
      json: 'application/json',
      md: 'text/markdown',
      css: 'text/css',
      html: 'text/html',
      txt: 'text/plain',
      py: 'text/x-python',
      rs: 'text/x-rust',
      go: 'text/x-go',
      yaml: 'text/yaml',
      yml: 'text/yaml',
      toml: 'text/toml',
      sql: 'text/sql',
      sh: 'text/x-shellscript',
      xml: 'text/xml',
      csv: 'text/csv',
      // Images
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      ico: 'image/x-icon',
      bmp: 'image/bmp',
      // Documents
      pdf: 'application/pdf',
      // Archives
      zip: 'application/zip',
      tar: 'application/x-tar',
      gz: 'application/gzip',
      // Audio
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      // Video
      mp4: 'video/mp4',
      webm: 'video/webm',
      // Fonts
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      otf: 'font/otf',
    };
    return types[ext] || 'application/octet-stream';
  }
}
