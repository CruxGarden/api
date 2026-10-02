import {
  Injectable,
  ServiceUnavailableException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingOperationsRepository } from './operations.repository';
import { EmailService } from '../common/services/email.service';
import { LoggerService } from '../common/services/logger.service';
import { operationResult, billingFailureCode } from './operations';
import { trialEndingEmail } from './billing.emails';

@Injectable()
export class BillingOperationsService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<{
    checked: number;
    failed: number;
    notices: number;
  }> | null = null;
  private lastRun: Date | null = null;
  private lastRunFailed = false;
  private readonly logger: LoggerService;
  constructor(
    private readonly billing: BillingService,
    private readonly repo: BillingOperationsRepository,
    private readonly email: EmailService,
    logger: LoggerService,
  ) {
    this.logger = logger.createChildLogger('BillingOperationsService');
  }

  onModuleInit() {
    if (
      this.billing.providerName !== 'stripe' ||
      process.env.NODE_ENV === 'test' ||
      process.env.BILLING_RECONCILIATION === '0'
    )
      return;
    const run = () => void this.sweep().catch(() => {}); // sweep logs a safe failure code
    this.timer = setInterval(run, 60_000);
    this.timer.unref();
    run();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
  }

  /** One bounded batch per process; durable per-account leases coordinate replicas. */
  sweep() {
    if (this.running) return this.running;
    this.running = this.runBatch()
      .then((result) => {
        this.lastRun = new Date();
        this.lastRunFailed = false;
        return result;
      })
      .catch((error) => {
        this.lastRun = new Date();
        this.lastRunFailed = true;
        this.logger.error('Billing monitoring batch failed', undefined, {
          code: billingFailureCode(error),
        });
        throw error;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private async runBatch() {
    const now = new Date();
    operationResult(await this.repo.discover(now));
    const candidates = operationResult(await this.repo.candidates(now));
    const deadline = Date.now() + 45_000;
    let checked = 0,
      failed = 0;
    for (const accountId of candidates) {
      if (Date.now() >= deadline) break;
      const result = await this.reconcile(accountId);
      if (result.status !== 'busy') checked++;
      if (result.status === 'failed') failed++;
    }
    const notices = await this.deliverNotices();
    return { checked, failed, notices };
  }

  async reconcile(accountId: string, force = false) {
    const lease = operationResult(
      await this.repo.claim(accountId, new Date(), force),
    );
    if (!lease) return { status: 'busy' as const };
    let code: string | null = null;
    try {
      await this.billing.sync(accountId);
      if (this.billing.providerName !== 'simulation') {
        const trial = operationResult(
          await this.repo.trialNotice(accountId, new Date()),
        );
        if (trial)
          operationResult(
            await this.repo.enqueue(
              accountId,
              trialEndingEmail(trial.end),
              trial.key,
              {
                subscriptionId: trial.subscriptionId,
                status: 'trialing',
                trialEndsAt: trial.end.toISOString(),
              },
            ),
          );
      }
    } catch (error) {
      code = billingFailureCode(error);
      this.logger.warn('Billing reconciliation failed', { accountId, code });
    }
    const finished = operationResult(
      await this.repo.finish(accountId, lease, new Date(), code),
    );
    if (!finished)
      throw new ServiceUnavailableException(
        'Billing reconciliation lease expired',
      );
    if (!code)
      this.logger.info('Billing reconciliation verified', { accountId });
    return { status: code ? ('failed' as const) : ('verified' as const), code };
  }

  async deliverNotices() {
    let sent = 0;
    const notices = operationResult(await this.repo.dueNotices(new Date()));
    for (const notice of notices) {
      const lease = operationResult(
        await this.repo.claimNotice(notice.id, new Date()),
      );
      if (!lease) continue;
      let code: string | null = null;
      let outcome = 'sent';
      try {
        const recipient = operationResult(
          await this.repo.recipient(notice.account_id),
        );
        // Account closure suppresses queued mail; a deleted account is not a send failure.
        const condition =
          typeof notice.condition === 'string'
            ? JSON.parse(notice.condition)
            : notice.condition;
        const current = condition
          ? operationResult(
              await this.repo.noticeSubscription(notice.account_id),
            )
          : null;
        const relevant =
          !condition ||
          (current?.subscription_id === condition.subscriptionId &&
            (!condition.status || current.status === condition.status) &&
            (!condition.planId ||
              (await this.billing.planIdFor(notice.account_id)) ===
                condition.planId) &&
            (!condition.trialEndsAt ||
              (new Date(condition.trialEndsAt) > new Date() &&
                new Date(current.trial_end).toISOString() ===
                  condition.trialEndsAt)));
        if (!recipient) outcome = 'account_closed';
        else if (!relevant) outcome = 'superseded';
        else {
          if (this.email.deliveryMode !== 'ses')
            throw new ServiceUnavailableException(
              'Billing email delivery is unconfigured',
            );
          await this.email.send({
            email: recipient,
            subject: notice.subject,
            body: notice.body,
          });
          sent++;
        }
      } catch (error) {
        code =
          this.email.deliveryMode !== 'ses'
            ? 'email_unconfigured'
            : billingFailureCode(error);
        this.logger.warn('Billing notice delivery deferred', {
          noticeId: notice.id,
          code,
        });
      }
      if (
        !operationResult(
          await this.repo.finishNotice(
            notice,
            lease,
            new Date(),
            code,
            outcome,
          ),
        )
      )
        throw new ServiceUnavailableException(
          'Billing notice delivery lease expired',
        );
    }
    return sent;
  }

  async health() {
    const [state, problems, catalog] = await Promise.all([
      this.repo.health(new Date()),
      this.repo.problems(),
      this.billing.catalog().catch(() => null),
    ]);
    const counters = operationResult(state);
    const details = operationResult(problems);
    return {
      provider: this.billing.providerName,
      scheduler: {
        enabled: !!this.timer,
        running: !!this.running,
        lastRun: this.lastRun,
        lastRunFailed: this.lastRunFailed,
      },
      emailDelivery: this.email.deliveryMode,
      prices: {
        available: !!catalog?.plans.some((p) => p.prices.length),
        missing: catalog
          ? catalog.plans
              .filter((p) => p.plan.id !== 'free')
              .flatMap((p) =>
                ['month', 'year']
                  .filter(
                    (interval) =>
                      !p.prices.some((price) => price.interval === interval),
                  )
                  .map((interval) => ({ planId: p.plan.id, interval })),
              )
          : null,
      },
      counters,
      problems: details,
    };
  }
}
