/** Emails the billing service sends. Plain text, short, no marketing. */
export function planChangedEmail(
  fromPlan: string,
  toPlan: string,
  renewsAt: Date | null,
) {
  const when = renewsAt
    ? ` It renews on ${renewsAt.toISOString().slice(0, 10)}.`
    : '';
  if (toPlan === 'Free')
    return {
      subject: 'Your Crux Garden plan is now Free',
      body: `Your ${fromPlan} subscription has ended and your account is on the Free plan. Everything you've published stays up; new publishes follow the Free limits. You can pick a plan again any time in Settings → Plan.\n\n— Crux Garden`,
    };
  return {
    subject: `You're on Crux Garden ${toPlan}`,
    body: `Your plan is now ${toPlan}${fromPlan !== 'Free' ? ` (was ${fromPlan})` : ''}.${when} Stripe sends the receipt separately. Change or cancel any time in Settings → Plan → Manage billing.\n\n— Crux Garden`,
  };
}

export function paymentFailedEmail(plan: string) {
  return {
    subject: 'Crux Garden: your payment didn’t go through',
    body: `We couldn't charge your card for the ${plan} plan. Your plan stays active for 7 days while Stripe retries. To fix it now, open Crux Garden → Settings → Plan → Manage billing and update the card.\n\n— Crux Garden`,
  };
}

export function trialEndingEmail(end: Date) {
  return {
    subject: 'Your Crux Garden trial ends soon',
    body: `Your trial ends on ${end.toISOString().slice(0, 10)}. Open Settings → Plan → Manage billing to review the price, add a payment method, or cancel. Check your plan after returning. Everything you have published stays up.\n\n— Crux Garden`,
  };
}

/** Sent once when an account with a billing customer is closed (ADR 0083). */
export function accountClosedEmail(
  plan: string | null,
  invoices: {
    number: string | null;
    date: string;
    totalCents: number;
    currency: string;
    status: string;
    hostedUrl: string | null;
    pdfUrl: string | null;
  }[],
) {
  const ended = plan
    ? ` Your ${plan} subscription was canceled immediately. Remaining time on the plan is not refunded.`
    : ' No subscription was active.';
  const list = invoices.length
    ? `\n\nYour billing details have been removed from our payment provider, so these invoice links may not stay available. Download any you need now:\n\n${invoices
        .map((inv) => {
          const amount = `${inv.currency.toUpperCase()} ${(inv.totalCents / 100).toFixed(2)}`;
          const head = `${inv.date.slice(0, 10)} · ${inv.number ?? 'invoice'} · ${amount} · ${inv.status}`;
          const links = [
            inv.hostedUrl ? `  View: ${inv.hostedUrl}` : null,
            inv.pdfUrl ? `  PDF: ${inv.pdfUrl}` : null,
          ].filter(Boolean);
          return [head, ...links].join('\n');
        })
        .join('\n')}`
    : '\n\nThere were no invoices on this account.';
  return {
    subject: 'Your Crux Garden account is closed',
    body: `You asked us to close your Crux Garden account.${ended}${list}\n\n— Crux Garden`,
  };
}
