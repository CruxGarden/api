import {
  All,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  Sse,
  UseGuards,
  MessageEvent,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable, filter, map } from 'rxjs';
import { OptionalAuthGuard } from '../common/guards/optional-auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { AuthorService } from '../author/author.service';
import { FunctionsService } from './functions.service';

/**
 * A published crux's functions and events (CRUX-FUNCTIONS-PLAN F0 + F6):
 *
 *   GET  /fn/:cruxId              what the crux's functions/ folder holds (with schedules)
 *   ANY  /fn/:cruxId/:name[/rest] run an HTTP handler — the crux's own API: the method,
 *                                 the rest of the path, the query and the headers reach
 *                                 req; ctx.json / text / html / redirect shape the answer
 *   POST /events/:cruxId/:name    emit an event (crux.emit): handlers run, listeners hear it
 *   GET  /events/:cruxId          the crux's event stream (crux.on), server-sent
 *
 * The visitor is whoever the Store SDK's token names, as for the Store.
 */
@Controller()
export class FunctionsController {
  constructor(
    private readonly functions: FunctionsService,
    private readonly authorService: AuthorService,
  ) {}

  private async visitorId(req: AuthRequest): Promise<string | null> {
    if (!req.account) return null;
    try {
      const author = await this.authorService.findByAccountId(req.account.id);
      return author?.id ?? null;
    } catch {
      return null;
    }
  }

  @Get('fn/:cruxId')
  @UseGuards(OptionalAuthGuard)
  async list(@Param('cruxId') cruxId: string) {
    return this.functions.listWithSchedules(cruxId);
  }

  @All('fn/:cruxId/:name')
  @UseGuards(OptionalAuthGuard)
  async call(
    @Param('cruxId') cruxId: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(cruxId, name, '', body, req, res);
  }

  @All('fn/:cruxId/:name/*rest')
  @UseGuards(OptionalAuthGuard)
  async callRest(
    @Param('cruxId') cruxId: string,
    @Param('name') name: string,
    @Param('rest') rest: string | string[],
    @Body() body: unknown,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      cruxId,
      name,
      Array.isArray(rest) ? rest.join('/') : String(rest ?? ''),
      body,
      req,
      res,
    );
  }

  private async run(
    cruxId: string,
    name: string,
    rest: string,
    body: unknown,
    req: AuthRequest,
    res: Response,
  ) {
    const r = req as unknown as {
      method: string;
      query: Record<string, string | string[]>;
      headers: Record<string, string | string[] | undefined>;
    };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) {
      if (k === 'authorization' || k === 'cookie') continue;
      if (typeof v === 'string') headers[k] = v;
    }
    const result = await this.functions.call(cruxId, name, {
      body: body ?? null,
      visitorId: await this.visitorId(req),
      method: r.method,
      rest,
      query: r.query ?? {},
      headers,
    });
    res.status(result.status);
    res.setHeader('X-Crux-Function-Ms', String(result.ms));
    if (result.logs.length)
      res.setHeader(
        'X-Crux-Function-Logs',
        encodeURIComponent(result.logs.join('\n')),
      );
    for (const [k, v] of Object.entries(result.headers ?? {}))
      res.setHeader(k, v);
    if (result.contentType) {
      res.setHeader('Content-Type', result.contentType);
      res.send(result.body);
      return undefined;
    }
    return result.body;
  }

  @Post('events/:cruxId/:name')
  @HttpCode(202)
  @UseGuards(OptionalAuthGuard)
  async emit(
    @Param('cruxId') cruxId: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() req: AuthRequest,
  ) {
    const { handlers, results } = await this.functions.emit(
      cruxId,
      name,
      body ?? null,
      await this.visitorId(req),
    );
    return { event: name, handlers, results };
  }

  @Sse('events/:cruxId')
  stream(@Param('cruxId') cruxId: string): Observable<MessageEvent> {
    return this.functions.events.pipe(
      filter((e) => e.cruxId === cruxId),
      map((e) => ({ type: e.event.name, data: e.event }) as MessageEvent),
    );
  }
}
