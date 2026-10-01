import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BillingRepository, type CheckoutAttempt } from './billing.repository';
import type {
  BillingProvider,
  CheckoutRequest,
  CheckoutSessionInfo,
} from './provider';
import type { RepositoryResponse } from '../common/types/interfaces';

function required<T>(result: RepositoryResponse<T>): T {
  if (result.error)
    throw new ServiceUnavailableException(
      'Checkout state could not be saved or read',
    );
  return result.data;
}

export async function requireOpenAccount(
  repo: BillingRepository,
  accountId: string,
) {
  if (required(await repo.isClosing(accountId)))
    throw new BadRequestException(
      'Account closure is in progress. Retry closure before making billing changes.',
    );
}

/** Call under the account lock, then COMMIT before calling the provider.
 * Persist the exact request so a retry cannot change its idempotent parameters.
 */
export async function reserveCheckout(
  repo: BillingRepository,
  provider: BillingProvider,
  request: CheckoutRequest,
): Promise<CheckoutAttempt> {
  await requireOpenAccount(repo, request.accountId);
  const previous = required(await repo.checkoutAttempt(request.accountId));
  if (previous && previous.provider !== provider.name)
    throw new BadRequestException(
      'The pending checkout uses another billing provider',
    );
  if (previous && ['preparing', 'open'].includes(previous.status)) {
    if (previous.request.priceId !== request.priceId)
      throw new BadRequestException(
        'Resume or cancel the pending checkout before choosing a different price.',
      );
    return previous;
  }
  const row = required(await repo.byAccount(request.accountId));
  if (row?.pending_session_id)
    throw new BadRequestException(
      'Resume or cancel the pending checkout before creating another.',
    );
  const now = new Date();
  const id = randomUUID();
  const attempt: CheckoutAttempt = {
    id,
    account_id: request.accountId,
    provider: provider.name,
    request: { ...request, idempotencyKey: id },
    status: 'preparing',
    session_id: null,
    session_url: null,
    created_at: now,
    updated_at: now,
  };
  required(await repo.saveCheckoutAttempt(attempt));
  return attempt;
}

function ownedSession(
  attempt: CheckoutAttempt,
  session: CheckoutSessionInfo | null,
): CheckoutSessionInfo {
  if (!session || session.accountId !== attempt.account_id)
    throw new ServiceUnavailableException(
      'Pending checkout ownership could not be verified',
    );
  return session;
}

/** Call under the account lock, using an intent committed by reserveCheckout.
 * A crash after Stripe succeeds can lose the local result, but not its retry key.
 */
export async function resumeCheckout(
  repo: BillingRepository,
  provider: BillingProvider,
  accountId: string,
  allowClosing = false,
): Promise<{ url: string; sessionId: string }> {
  if (!allowClosing) await requireOpenAccount(repo, accountId);
  const attempt = required(await repo.checkoutAttempt(accountId));
  if (!attempt) {
    const row = required(await repo.byAccount(accountId));
    if (!row?.pending_session_id || row.provider !== provider.name)
      throw new BadRequestException(
        'No pending checkout for this billing provider',
      );
    const session = await provider.fetchCheckoutSession(row.pending_session_id);
    if (!session || session.accountId !== accountId)
      throw new ServiceUnavailableException(
        'Pending checkout ownership could not be verified',
      );
    if (session.status !== 'open' || !session.url)
      throw new BadRequestException(
        'Checkout is no longer open. Check your plan to synchronize it.',
      );
    return { url: session.url, sessionId: row.pending_session_id };
  }
  if (attempt.provider !== provider.name)
    throw new BadRequestException(
      'The pending checkout uses another billing provider',
    );
  if (attempt.status === 'expired')
    throw new BadRequestException('Checkout expired. Choose a plan again.');
  if (attempt.session_id) {
    const session = ownedSession(
      attempt,
      await provider.fetchCheckoutSession(attempt.session_id),
    );
    if (session.status === 'expired') {
      // The caller commits this status separately when cancelling; no new external
      // checkout is created from a possibly stale URL.
      throw new BadRequestException(
        'Checkout expired. Cancel the pending checkout, then choose a plan.',
      );
    }
    const url =
      session.url ??
      (session.status === 'complete'
        ? attempt.request.successUrl.replace(
            '{CHECKOUT_SESSION_ID}',
            attempt.session_id,
          )
        : null);
    if (!url)
      throw new ServiceUnavailableException(
        'The pending checkout URL is unavailable',
      );
    return { url, sessionId: attempt.session_id };
  }
  // Stripe may prune keys after 24 hours. Never risk charging twice by silently
  // reusing an old ambiguous key as though it still guaranteed idempotency.
  if (Date.now() - new Date(attempt.created_at).getTime() >= 23 * 60 * 60_000)
    throw new ServiceUnavailableException(
      'Checkout confirmation needs operator recovery. Do not start another payment.',
    );
  const result = await provider.createCheckout(attempt.request);
  required(
    await repo.saveCheckoutAttempt({
      ...attempt,
      status: 'open',
      session_id: result.sessionId,
      session_url: result.url,
    }),
  );
  required(
    await repo.setPendingSession(accountId, result.sessionId, provider.name),
  );
  return result;
}

/** Expiration is confirmed at the provider before releasing the local attempt. */
export async function cancelCheckout(
  repo: BillingRepository,
  provider: BillingProvider,
  accountId: string,
): Promise<CheckoutSessionInfo | null> {
  const attempt = required(await repo.checkoutAttempt(accountId));
  const row = required(await repo.byAccount(accountId));
  if (row && row.provider !== provider.name)
    throw new BadRequestException(
      'Restore the original billing provider before changing checkout',
    );
  let sessionId = attempt?.session_id ?? row?.pending_session_id;
  if (attempt && attempt.provider !== provider.name)
    throw new BadRequestException(
      'The pending checkout uses another billing provider',
    );
  if (attempt?.status === 'preparing' && !sessionId)
    sessionId = (await resumeCheckout(repo, provider, accountId, true))
      .sessionId;
  if (!sessionId) return null;
  const before = await provider.fetchCheckoutSession(sessionId);
  if (!before || before.accountId !== accountId)
    throw new ServiceUnavailableException(
      'Pending checkout ownership could not be verified',
    );
  const session = await provider.expireCheckout(sessionId);
  if (session.accountId !== accountId || session.status === 'open')
    throw new ServiceUnavailableException(
      'Checkout cancellation could not be confirmed',
    );
  if (attempt)
    required(
      await repo.saveCheckoutAttempt({
        ...attempt,
        session_id: sessionId,
        session_url: session.url,
        status: session.status === 'complete' ? 'completed' : 'expired',
      }),
    );
  if (session.status === 'expired')
    required(await repo.setPendingSession(accountId, null));
  return session;
}

/** Operator repair after a lost result outlived the provider's retry-key window.
 * Metadata must identify this exact attempt, not just the same customer.
 */
export async function recoverCheckout(
  repo: BillingRepository,
  provider: BillingProvider,
  accountId: string,
  sessionId: string,
) {
  const attempt = required(await repo.checkoutAttempt(accountId));
  const session = await provider.fetchCheckoutSession(sessionId);
  if (
    !attempt ||
    attempt.provider !== provider.name ||
    !session ||
    session.accountId !== accountId ||
    session.attemptId !== attempt.id
  )
    throw new BadRequestException(
      'The provider session does not belong to this checkout attempt',
    );
  required(
    await repo.saveCheckoutAttempt({
      ...attempt,
      session_id: sessionId,
      session_url: session.url,
      status:
        session.status === 'open'
          ? 'open'
          : session.status === 'complete'
            ? 'completed'
            : 'expired',
    }),
  );
  required(
    await repo.setPendingSession(
      accountId,
      session.status === 'expired' ? null : sessionId,
      provider.name,
    ),
  );
}
