import { includedImagesAvailable } from './image.service';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { Response } from 'express';
import { LoggerService } from '../common/services/logger.service';
import { BillingService } from '../billing/billing.service';
import { NotificationsService } from '../usage/notifications.service';
import {
  InferenceRepository,
  ReservationError,
  remainingOf,
  usageTotals,
  type InferenceKind,
  type Reserved,
  type SettlementStatus,
  type UsageRow,
} from './inference.repository';
import { notifyIncludedAllowance } from './allowance-notice';
import {
  ALLOWANCES,
  SONNET,
  EFFORT,
  HOUR,
  MAX_INPUT,
  MAX_OUTPUT,
  MIN_USEFUL_OUTPUT,
  cost,
  outputEstimate,
  reservation,
  validTokens,
  validateRequest,
  type Tokens,
} from './policy';

const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A reservation older than this belongs to a request that died with its server. */
export const STALE_RESERVATION_MS = 15 * 60_000;

/**
 * The `x-crux-id` attribution label: a UUID or nothing. It only labels the
 * ledger row for the person's own usage view; it never authorizes anything.
 */
export function attributedCrux(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value)
    ? value.toLowerCase()
    : null;
}
/** `?contextTokens=` on the usage route: absent, or a whole number of tokens. */
export function parseContextTokens(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value))
    throw new BadRequestException(
      'contextTokens must be a whole number of tokens.',
    );
  return Number(value);
}
const promptTokens = (r: UsageRow) =>
  Number(r.input_tokens ?? 0) +
  Number(r.cache_read_tokens ?? 0) +
  Number(r.cache_write_tokens ?? 0);
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
const kindOf = (r: UsageRow): InferenceKind =>
  r.kind === 'image' ? 'image' : 'chat';

@Injectable()
export class InferenceService {
  private readonly logger: LoggerService;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly repo: InferenceRepository,
    private readonly billing: BillingService,
    logger: LoggerService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {
    this.logger = logger.createChildLogger('InferenceService');
  }
  private provider(): Anthropic {
    if (!this.available())
      throw new ServiceUnavailableException(
        'Included collaboration is temporarily unavailable. Your work is saved; please try again shortly.',
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
  async usage(accountId: string, now = new Date(), contextTokens?: number) {
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
    // Per-Crux attribution, chat and images apart (ADR 0082).
    const groups = new Map<
      string,
      {
        cruxId: string | null;
        kind: InferenceKind;
        microdollars: number;
        requests: number;
      }
    >();
    for (const r of rows) {
      if (r.status === 'rejected') continue;
      const cruxId = r.crux_id ?? null;
      const kind = kindOf(r);
      const key = `${cruxId ?? ''}|${kind}`;
      const group = groups.get(key) ?? {
        cruxId,
        kind,
        microdollars: 0,
        requests: 0,
      };
      group.microdollars += Number(r.charged_microdollars);
      group.requests += 1;
      groups.set(key, group);
    }
    // The next request, by the same admission math the reservation uses.
    const history = rows
      .filter((r) => r.status === 'complete' && kindOf(r) === 'chat')
      .slice(-10)
      .map(promptTokens);
    const assumed =
      contextTokens ?? (history.length ? median(history) : undefined);
    const context = assumed ?? 0;
    const remaining = limits ? remainingOf(rows, limits, now) : 0;
    const minimum = reservation(SONNET, context, MIN_USEFUL_OUTPUT);
    const fullLength = reservation(SONNET, context, MAX_OUTPUT);
    const admissible = !!limits && context <= MAX_INPUT;
    return {
      available: this.available(),
      imagesAvailable: includedImagesAvailable(),
      planId,
      eligible: !!limits,
      model: SONNET,
      asOf: now.toISOString(),
      windows: limits
        ? [
            window(5, limits.fiveHour, totals.fiveHour),
            window(720, limits.thirtyDay, totals.thirtyDay),
          ]
        : [],
      nextRequest: {
        contextTokens: assumed ?? null,
        minimumMicrodollars: minimum,
        fits: admissible && minimum <= remaining,
        fullLengthFits: admissible && fullLength <= remaining,
      },
      requests: rows.length,
      recentRequests: rows
        .slice(-20)
        .reverse()
        .map((r) => ({
          id: r.id,
          model: r.model,
          kind: kindOf(r),
          status: r.status,
          adjusted: !!r.adjusted,
          createdAt: new Date(r.created).toISOString(),
          allowancePercent: limits
            ? (Number(r.charged_microdollars) / limits.thirtyDay) * 100
            : null,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
        })),
      byCrux: [...groups.values()].sort(
        (a, b) => b.microdollars - a.microdollars || b.requests - a.requests,
      ),
      tokens: {
        input: sum('input'),
        output: sum('output'),
        cacheRead: sum('cacheRead'),
        cacheWrite: sum('cacheWrite'),
      },
      uncertainRequests: rows.filter(
        (r) =>
          (r.status === 'uncertain' && !r.adjusted) || r.status === 'reserved',
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
    cruxId: string | null = null,
  ): Promise<void> {
    if (!REQUEST_ID.test(requestId || ''))
      throw new BadRequestException('Supply a UUID request ID.');
    const body = validateRequest(value);
    await this.billing.assertNotSuspended(accountId);
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
    let reserved: Reserved | null = null;
    let complete = false;
    let upstreamStarted = false;
    // Measured as it streams (ADR 0082): input and cache from message_start,
    // output from the latest message_delta, else estimated from streamed text.
    let tokens: Tokens | null = null;
    let reportedOutput: number | null = null;
    let streamedCharacters = 0;
    let progress: Promise<unknown> | null = null;
    try {
      // One model for both tiers; the tier shows up as effort and allowance.
      const models = [SONNET];
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
            result.input_tokens > MAX_INPUT
          )
            throw new BadRequestException(
              'This request exceeds the included 100,000-token input budget. Shorten the conversation or use your own key.',
            );
          const output = Number(body.max_tokens);
          return {
            model,
            amount: reservation(model, result.input_tokens, output),
            input: result.input_tokens,
            output,
          };
        }),
      );
      if (abort.signal.aborted) return;
      const result = await this.repo.reserve(
        accountId,
        requestId,
        choices,
        limit,
        new Date(),
        { cruxId, kind: 'chat' },
      );
      if (result.error) throw result.error;
      if (!result.data)
        throw new ServiceUnavailableException('Could not reserve allowance.');
      reserved = result.data;
      if (abort.signal.aborted) return;
      // Clamp instead of refuse: a shorter reply rather than none.
      const maxTokens = reserved.maxTokens ?? Number(body.max_tokens);
      upstreamStarted = true;
      const stream = await provider.messages.create(
        {
          ...body,
          model: reserved.model,
          max_tokens: maxTokens,
          output_config: { effort: EFFORT[planId] ?? 'medium' },
          stream: true,
        } as Anthropic.MessageCreateParamsStreaming,
        { signal: abort.signal },
      );
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Included-Model', reserved.model);
      res.setHeader('X-Included-Max-Tokens', String(maxTokens));
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
          if (validTokens(tokens))
            progress = this.repo.progress(accountId, requestId, {
              ...tokens,
            });
        } else if (event.type === 'message_delta' && tokens) {
          reportedOutput = event.usage.output_tokens;
          tokens.output = event.usage.output_tokens;
        } else if (event.type === 'content_block_delta') {
          const d = event.delta as unknown as Record<string, unknown>;
          for (const key of ['text', 'partial_json', 'thinking'])
            if (typeof d[key] === 'string')
              streamedCharacters += (d[key] as string).length;
        } else if (event.type === 'message_stop') complete = true;
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
                : 'There is not enough included collaboration left for this conversation right now. Check Usage for the next release, start a shorter conversation, or use your own API key.',
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
      if (progress) await progress;
      if (reserved) {
        const s = settlement(
          reserved,
          complete,
          upstreamStarted,
          tokens,
          reportedOutput,
          streamedCharacters,
        );
        const settled = await this.repo.settle(
          accountId,
          requestId,
          s.amount,
          s.tokens,
          s.status,
        );
        if (settled.error)
          this.logger.error(
            'Usage settlement failed; reservation retained',
            undefined,
            {
              accountId,
              requestId,
            },
          );
        else if (s.amount > 0)
          void notifyIncludedAllowance(
            this.repo,
            this.notifications,
            this.logger,
            accountId,
            planId,
          );
      }
      if (res.headersSent && !res.writableEnded) res.end();
    }
  }
  /**
   * Settle reservations whose request died with its server (ADR 0082): at the
   * measured usage recorded at message_start when there is some, otherwise
   * released to zero as `abandoned`. Compare-and-set, so any instance may run it.
   */
  async sweep(
    now = new Date(),
  ): Promise<{ interrupted: number; abandoned: number }> {
    const counts = { interrupted: 0, abandoned: 0 };
    const stale = await this.repo.stale(
      new Date(now.getTime() - STALE_RESERVATION_MS),
    );
    if (stale.error || !stale.data) {
      if (stale.error)
        this.logger.error('Stale reservation sweep failed', stale.error);
      return counts;
    }
    for (const row of stale.data) {
      const measured: Tokens = {
        input: Number(row.input_tokens),
        output: Number(row.output_tokens ?? 0),
        cacheRead: Number(row.cache_read_tokens ?? 0),
        cacheWrite: Number(row.cache_write_tokens ?? 0),
      };
      const known = row.input_tokens !== null && validTokens(measured);
      const reservedAmount = Number(
        row.reserved_microdollars ?? row.charged_microdollars,
      );
      const result = await this.repo.settle(
        String(row.account_id),
        row.id,
        known ? Math.min(reservedAmount, cost(row.model, measured)) : 0,
        known ? measured : null,
        known ? 'interrupted' : 'abandoned',
      );
      if (result.error) {
        this.logger.error('Stale reservation settlement failed', undefined, {
          requestId: row.id,
        });
        continue;
      }
      counts[known ? 'interrupted' : 'abandoned'] += 1;
    }
    if (counts.interrupted || counts.abandoned)
      this.logger.info('Stale included reservations settled', counts);
    return counts;
  }
  startSweeper(intervalMs = 5 * 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(
      () => void this.sweep().catch(() => {}),
      intervalMs,
    );
  }
  stopSweeper(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
  /** Operator correction: lower-only, settled requests only, always logged. */
  async adjust(
    adminAccountId: string,
    id: string,
    chargedMicrodollars: number,
    reason: string,
  ) {
    if (!Number.isSafeInteger(chargedMicrodollars) || chargedMicrodollars < 0)
      throw new BadRequestException(
        'chargedMicrodollars must be a whole number of microdollars, zero or more.',
      );
    const note = String(reason ?? '').trim();
    if (!note) throw new BadRequestException('Give a reason for the record.');
    const found = await this.repo.find(id);
    if (found.error)
      throw new ServiceUnavailableException('Included usage is unavailable.');
    const row = found.data;
    if (!row) throw new NotFoundException('No such included request.');
    if (row.status === 'reserved')
      throw new ConflictException(
        'This request is still running. Adjust it after it settles.',
      );
    const before = Number(row.charged_microdollars);
    if (chargedMicrodollars >= before)
      throw new BadRequestException('An adjustment can only lower a charge.');
    const updated = await this.repo.adjust(
      id,
      chargedMicrodollars,
      note,
      adminAccountId,
    );
    if (updated.error)
      throw new ServiceUnavailableException('Included usage is unavailable.');
    if (!updated.data)
      throw new ConflictException(
        'The request changed while adjusting. Read it again and retry.',
      );
    this.logger.info('Included charge lowered by an operator', {
      requestId: id,
      accountId: row.account_id,
      adminAccountId,
      fromMicrodollars: before,
      toMicrodollars: chargedMicrodollars,
      reason: note,
    });
    return {
      id,
      status: updated.data.status,
      chargedMicrodollars: Number(updated.data.charged_microdollars),
      adjustedFromMicrodollars: Number(
        updated.data.adjusted_from_microdollars ?? before,
      ),
      reason: note,
    };
  }
}
/**
 * How a chat reservation settles (ADR 0082). Complete: the provider's count.
 * Interrupted after message_start: the measured cost, never above the
 * reservation. Started with nothing measured: the reservation, `uncertain`.
 * Never started: released.
 */
export function settlement(
  reserved: Reserved,
  complete: boolean,
  upstreamStarted: boolean,
  tokens: Tokens | null,
  reportedOutput: number | null,
  streamedCharacters: number,
): { amount: number; tokens: Tokens | null; status: SettlementStatus } {
  if (complete && validTokens(tokens))
    return {
      amount: cost(reserved.model, tokens),
      tokens,
      status: 'complete',
    };
  if (!upstreamStarted) return { amount: 0, tokens: null, status: 'rejected' };
  if (tokens) {
    const measured: Tokens = {
      ...tokens,
      output:
        reportedOutput ??
        Math.max(tokens.output, outputEstimate(streamedCharacters)),
    };
    if (validTokens(measured))
      return {
        amount: Math.min(reserved.amount, cost(reserved.model, measured)),
        tokens: measured,
        status: 'interrupted',
      };
  }
  return { amount: reserved.amount, tokens: null, status: 'uncertain' };
}
