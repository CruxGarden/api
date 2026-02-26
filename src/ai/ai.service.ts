import { Injectable, NotFoundException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { LoggerService } from '../common/services/logger.service';
import { AttachmentService } from '../attachment/attachment.service';
import { CruxService } from '../crux/crux.service';
import { TOOL_DEFINITIONS } from './ai.tools';
import { Response } from 'express';

interface StreamContext {
  cruxId: string;
  authorId: string;
  homeId: string;
  res: Response;
}

@Injectable()
export class AiService {
  private readonly logger: LoggerService;
  private readonly client: Anthropic;

  constructor(
    private readonly loggerService: LoggerService,
    private readonly attachmentService: AttachmentService,
    private readonly cruxService: CruxService,
  ) {
    this.logger = this.loggerService.createChildLogger('AiService');

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI features disabled');
    }
    this.client = new Anthropic({ apiKey: apiKey || 'dummy' });
  }

  async streamChat(
    cruxId: string,
    messages: { role: 'user' | 'assistant'; content: string }[],
    model: string,
    authorId: string,
    res: Response,
  ): Promise<void> {
    // Load crux for context
    const crux = await this.cruxService.findById(cruxId);
    if (!crux) throw new NotFoundException('Crux not found');

    const ctx: StreamContext = {
      cruxId,
      authorId,
      homeId: crux.homeId,
      res,
    };

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(crux);

    // Convert messages for Anthropic API
    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      await this.runConversationLoop(
        systemPrompt,
        anthropicMessages,
        model,
        ctx,
      );
    } catch (error: any) {
      this.logger.error(`Stream error: ${error.message}`);
      this.sendSSE(res, 'error', { message: error.message });
    } finally {
      this.sendSSE(res, 'done', {});
      res.end();
    }
  }

  private async runConversationLoop(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    model: string,
    ctx: StreamContext,
  ): Promise<void> {
    const MAX_TOOL_ROUNDS = 10;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.streamResponse(
        systemPrompt,
        messages,
        model,
        ctx,
      );

      // If no tool use, we're done
      if (response.stopReason !== 'tool_use') break;

      // Process tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of response.toolCalls) {
        this.sendSSE(ctx.res, 'tool_start', {
          name: toolUse.name,
          id: toolUse.id,
          input: toolUse.input,
        });

        const result = await this.executeTool(toolUse, ctx);

        this.sendSSE(ctx.res, 'tool_result', {
          name: toolUse.name,
          id: toolUse.id,
          result,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Add assistant response + tool results to messages for next round
      messages.push({
        role: 'assistant',
        content: response.contentBlocks,
      });
      messages.push({
        role: 'user',
        content: toolResults,
      });
    }
  }

  private async streamResponse(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    model: string,
    ctx: StreamContext,
  ): Promise<{
    stopReason: string;
    toolCalls: { id: string; name: string; input: any }[];
    contentBlocks: Anthropic.ContentBlock[];
  }> {
    const stream = this.client.messages.stream({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: TOOL_DEFINITIONS,
    });

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

    return {
      stopReason: finalMessage.stop_reason,
      toolCalls,
      contentBlocks,
    };
  }

  private async executeTool(
    toolUse: { id: string; name: string; input: any },
    ctx: StreamContext,
  ): Promise<string> {
    try {
      switch (toolUse.name) {
        case 'write_file':
          return await this.toolWriteFile(
            toolUse.input.path,
            toolUse.input.content,
            ctx,
            toolUse.input.encoding,
          );
        case 'read_file':
          return await this.toolReadFile(toolUse.input.path, ctx);
        case 'list_files':
          return await this.toolListFiles(ctx);
        case 'get_palette':
          return await this.toolGetPalette(ctx);
        case 'set_palette':
          return 'Palette applied to workspace.';
        default:
          return `Unknown tool: ${toolUse.name}`;
      }
    } catch (error: any) {
      return `Error: ${error.message}`;
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

  private async toolReadFile(
    path: string,
    ctx: StreamContext,
  ): Promise<string> {
    const attachment = await this.findAttachmentByPath(path, ctx.cruxId);
    if (!attachment) return `File not found: ${path}`;

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

    return attachments
      .map((a) => a.meta?.path || a.filename || a.id)
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
    return attachments.find((a) => a.meta?.path === path) || null;
  }

  private async toolGetPalette(ctx: StreamContext): Promise<string> {
    const crux = await this.cruxService.findById(ctx.cruxId);
    const defaultPalette = {
      bg: '#0b0d0c', surface: 'rgba(18, 21, 19, 0.7)', surfaceSolid: '#131514',
      panel: 'rgba(20, 24, 22, 0.6)', text: '#e2e4e3', textMuted: '#8b908d',
      border: 'rgba(82, 96, 86, 0.18)', accent: '#7db3a3',
      accentMuted: 'rgba(125, 179, 163, 0.12)', error: '#e63946',
      errorMuted: 'rgba(230, 57, 70, 0.15)',
      mesh1: '#0e1a16', mesh2: '#172220', mesh3: '#0d1512', mesh4: '#131c18',
      glassBlur: '12px', panelBlur: '16px',
      meshOpacity: '0.6', meshBlur: '120px', meshSpeed: '1', meshScale: '1',
      radius: '0.5rem', radiusSm: '0.375rem',
      fontDisplay: "'JetBrains Mono', monospace", fontBody: "'Outfit', sans-serif",
      fontMono: "'JetBrains Mono', monospace",
    };
    const stored = crux?.meta?.settings?.palette;
    const current = stored ? { ...defaultPalette, ...stored } : defaultPalette;
    return JSON.stringify(current, null, 2);
  }

  private buildSystemPrompt(crux: any): string {
    const parts: string[] = [];

    parts.push(
      'You are an AI collaborator in the Crux Garden workspace. You help users create, iterate, and refine their ideas through conversation.',
    );
    parts.push(
      'When the user asks you to create or modify files, use the write_file tool. Use read_file to review existing files, and list_files to see what exists.',
    );
    parts.push(
      'You can customize the workspace appearance using the set_palette tool. ' +
      'Beyond colors, you can control glass blur effects, the animated mesh background ' +
      '(opacity, blur, speed, scale — set meshOpacity to "0" to hide it entirely), ' +
      'border radius (set to "0" for sharp corners), and fonts (any CSS font stack). ' +
      'Use these to set moods, match brands, or create unique aesthetics. ' +
      'You can change any subset of properties — you don\'t need to set all of them.',
    );

    // Add crux summary if available
    if (crux.meta?.summary) {
      const s = crux.meta.summary;
      parts.push('\n--- Workspace Context ---');
      if (s.crux) parts.push(`Project: ${s.crux}`);
      if (s.purpose) parts.push(`Purpose: ${s.purpose}`);
      if (s.stage) parts.push(`Stage: ${s.stage}`);
      if (s.themes) parts.push(`Themes: ${s.themes}`);
      if (s.stack) parts.push(`Stack: ${s.stack}`);
    }

    // Always include current palette so the AI knows what it's working with
    const defaultPalette = {
      bg: '#0b0d0c', surface: 'rgba(18, 21, 19, 0.7)', surfaceSolid: '#131514',
      panel: 'rgba(20, 24, 22, 0.6)', text: '#e2e4e3', textMuted: '#8b908d',
      border: 'rgba(82, 96, 86, 0.18)', accent: '#7db3a3',
      accentMuted: 'rgba(125, 179, 163, 0.12)', error: '#e63946',
      errorMuted: 'rgba(230, 57, 70, 0.15)',
      mesh1: '#0e1a16', mesh2: '#172220', mesh3: '#0d1512', mesh4: '#131c18',
      glassBlur: '12px', panelBlur: '16px',
      meshOpacity: '0.6', meshBlur: '120px', meshSpeed: '1', meshScale: '1',
      radius: '0.5rem', radiusSm: '0.375rem',
      fontDisplay: "'JetBrains Mono', monospace", fontBody: "'Outfit', sans-serif",
      fontMono: "'JetBrains Mono', monospace",
    };
    const currentPalette = crux.meta?.settings?.palette
      ? { ...defaultPalette, ...crux.meta.settings.palette }
      : defaultPalette;
    parts.push('\n--- Current Palette ---');
    parts.push(JSON.stringify(currentPalette));

    return parts.join('\n');
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
