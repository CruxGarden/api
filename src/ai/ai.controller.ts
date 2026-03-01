import { BadRequestException, Body, Controller, Headers, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { AuthorService } from '../author/author.service';
import { AiService } from './ai.service';
import { ChatDto } from './dto/chat.dto';

@Controller('ai')
@UseGuards(AuthGuard)
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly authorService: AuthorService,
  ) {}

  @Post('chat')
  async chat(
    @Body() chatDto: ChatDto,
    @Req() req: AuthRequest,
    @Res() res: Response,
    @Headers('x-anthropic-key') userApiKey?: string,
  ): Promise<void> {
    if (!userApiKey) {
      throw new BadRequestException('x-anthropic-key header is required');
    }

    const model = chatDto.model || 'claude-sonnet-4-20250514';
    const author = await this.authorService.findByAccountId(req.account.id);

    await this.aiService.streamChat(
      chatDto.cruxId,
      chatDto.messages,
      model,
      author.id,
      res,
      userApiKey,
    );
  }
}
