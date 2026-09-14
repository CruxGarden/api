import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { Response } from 'express';
import { LoggerService } from '../common/services/logger.service';
import { BillingService } from '../billing/billing.service';
import {
  InferenceRepository,
  ReservationError,
  usageTotals,
} from './inference.repository';
import {
  ALLOWANCES,
  HAIKU,
  SONNET,
  HOUR,
  cost,
  reservation,
  validateRequest,
  type Tokens,
} from './policy';

@Injectable()
export class InferenceService {
  private readonly logger: LoggerService;
  constructor(
    private readonly repo: InferenceRepository,
    private readonly billing: BillingService,
    logger: LoggerService,
  ) {
    this.logger = logger.createChildLogger('InferenceService');
  }
  private provider(): Anthropic {
    if (!this.available())
      throw new ServiceUnavailableException(
        'Included collaboration is not configured yet. Your own API key still works.',
      );
    return new Anthropic({
      apiKey: process.env.INCLUDED_ANTHROPIC_API_KEY,
      maxRetries: 0,
      timeout: 300_000,
    });
  }
  available(): boolean {
    return (
      process.env.INCLUDED_INFERENCE_ENABLED === '1' &&
      !!process.env.INCLUDED_ANTHROPIC_API_KEY
    );
  }
  async usage(accountId: string, now = new Date()) {
    const planId = await this.billing.planIdFor(accountId, now);
    const limits = ALLOWANCES[planId] ?? null;
    const result = await this.repo.rows(accountId, now);
    if (result.error || !result.data)
      throw new ServiceUnavailableException('Included usage is unavailable.');
    const rows = result.data;
    const totals = usageTotals(rows, now);
    const window = (hours: number, limit: number, used: number) => {
      const relevant = rows.filter(
        (r) =>
          Number(r.charged_microdollars) > 0 &&
          new Date(r.created).getTime() > now.getTime() - hours * HOUR,
      );
      return {
        durationHours: hours,
        limitMicrodollars: limit,
        usedMicrodollars: used,
        remainingMicrodollars: Math.max(0, limit - used),
        nextReleaseAt: relevant.length
          ? new Date(
              new Date(relevant[0].created).getTime() + hours * HOUR,
            ).toISOString()
          : null,
      };
    };
    const recent = rows.filter(
      (r) => new Date(r.created).getTime() > now.getTime() - 5 * HOUR,
    );
    const sum = (key: keyof Tokens) =>
      rows.reduce(
        (n, r) =>
          n +
          Number(
            r[
              (
                {
                  input: 'input_tokens',
                  output: 'output_tokens',
                  cacheRead: 'cache_read_tokens',
                  cacheWrite: 'cache_write_tokens',
                } as const
              )[key]
            ] ?? 0,
          ),
        0,
      );
    return {
      available: this.available(),
      planId,
      eligible: !!limits,
      model:
        planId === 'gardener_plus' &&
        totals.premiumFiveHour < limits.premiumFiveHour
          ? SONNET
          : HAIKU,
      asOf: now.toISOString(),
      windows: limits
        ? [
            window(5, limits.fiveHour, totals.fiveHour),
            window(720, limits.thirtyDay, totals.thirtyDay),
          ]
        : [],
      requests: rows.length,
      recentRequests: rows
        .slice(-20)
        .reverse()
        .map((r) => ({
          id: r.id,
          model: r.model,
          status: r.status,
          createdAt: new Date(r.created).toISOString(),
          allowancePercent: limits
            ? (Number(r.charged_microdollars) / limits.thirtyDay) * 100
            : null,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
        })),
      tokens: {
        input: sum('input'),
        output: sum('output'),
        cacheRead: sum('cacheRead'),
        cacheWrite: sum('cacheWrite'),
      },
      uncertainRequests: rows.filter(
        (r) => r.status === 'uncertain' || r.status === 'reserved',
      ).length,
      activeRequests: recent.filter(
        (r) =>
          r.status === 'reserved' &&
          new Date(r.created).getTime() > now.getTime() - 600_000,
      ).length,
    };
  }
  async stream(
    accountId: string,
    requestId: string,
    value: unknown,
    res: Response,
  ): Promise<void> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestId || '',
      )
    )
      throw new BadRequestException('Supply a UUID request ID.');
    const body = validateRequest(value);
    const planId = await this.billing.planIdFor(accountId);
    const limit = ALLOWANCES[planId];
    if (!limit)
      throw new HttpException(
        'Included collaboration requires Gardener or Gardener Plus. You can use your own API key on any plan.',
        402,
      );
    const provider = this.provider();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 300_000);
    const disconnected = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', disconnected);
    let reserved: { model: string; amount: number } | null = null;
    let complete = false;
    let upstreamStarted = false;
    let tokens: Tokens | null = null;
    try {
      const models = planId === 'gardener_plus' ? [SONNET, HAIKU] : [HAIKU];
      const choices = await Promise.all(
        models.map(async (model) => {
          const result = await provider.messages.countTokens(
            {
              model,
              messages: body.messages,
              ...(body.system ? { system: body.system } : {}),
              ...(body.tools ? { tools: body.tools } : {}),
              ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
            } as Anthropic.MessageCountTokensParams,
            { signal: abort.signal },
          );
          if (
            !Number.isFinite(result.input_tokens) ||
            result.input_tokens < 0 ||
            result.input_tokens > 100_000
          )
            throw new BadRequestException(
              'This request exceeds the included 100,000-token input budget. Shorten the conversation or use your own key.',
            );
          return {
            model,
            amount: reservation(
              model,
              result.input_tokens,
              Number(body.max_tokens),
            ),
          };
        }),
      );
      if (abort.signal.aborted) return;
      const result = await this.repo.reserve(
        accountId,
        requestId,
        choices,
        limit,
      );
      if (result.error) throw result.error;
      if (!result.data)
        throw new ServiceUnavailableException('Could not reserve allowance.');
      reserved = result.data;
      if (abort.signal.aborted) return;
      upstreamStarted = true;
      const stream = await provider.messages.create(
        {
          ...body,
          model: reserved.model,
          stream: true,
        } as Anthropic.MessageCreateParamsStreaming,
        { signal: abort.signal },
      );
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Included-Model', reserved.model);
      res.flushHeaders();
      for await (const event of stream) {
        if (event.type === 'message_start') {
          const u = event.message.usage;
          tokens = {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
          };
        } else if (event.type === 'message_delta' && tokens)
          tokens.output = event.usage.output_tokens;
        else if (event.type === 'message_stop') complete = true;
        if (!res.destroyed)
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (e) {
      // HTTP rejection before a stream starts is explicitly unbilled; a transport failure is uncertain.
      if (e instanceof Anthropic.APIError && e.status && !res.headersSent)
        upstreamStarted = false;
      if (!res.destroyed) {
        if (res.headersSent)
          res.write(
            `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'The included collaborator was interrupted. Check Usage before retrying.' } })}\n\n`,
          );
        else if (e instanceof ReservationError)
          throw new HttpException(
            e.reason === 'duplicate'
              ? 'This request ID was already used. Check the existing result before starting another turn.'
              : e.reason === 'concurrent'
                ? 'Two included requests are already running. Wait for one to finish.'
                : 'Your included allowance is currently full. Check Usage for the next release, or use your own API key.',
            e.reason === 'duplicate' ? 409 : 429,
          );
        else if (e instanceof HttpException) throw e;
        else
          throw new ServiceUnavailableException(
            'The included model provider is unavailable. Please try again later or use your own API key.',
          );
      }
    } finally {
      clearTimeout(timeout);
      res.off('close', disconnected);
      abort.abort();
      if (reserved) {
        const settledTokens =
          complete &&
          tokens &&
          Object.values(tokens).every((n) => Number.isSafeInteger(n) && n >= 0)
            ? tokens
            : null;
        const settlement = await this.repo.settle(
          accountId,
          requestId,
          settledTokens
            ? cost(reserved.model, settledTokens)
            : upstreamStarted
              ? reserved.amount
              : 0,
          settledTokens,
          settledTokens
            ? 'complete'
            : upstreamStarted
              ? 'uncertain'
              : 'rejected',
        );
        if (settlement.error)
          this.logger.error(
            'Usage settlement failed; reservation retained',
            undefined,
            {
              accountId,
              requestId,
            },
          );
      }
      if (res.headersSent && !res.writableEnded) res.end();
    }
  }
}
