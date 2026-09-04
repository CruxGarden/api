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
