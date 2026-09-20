/**
 * Cron, the five-field kind — minute hour day-of-month month day-of-week —
 * in UTC, for Crux Function schedules (CRUX-FUNCTIONS-PLAN F3). The same
 * grammar the desktop's Schedules use (app `services/cron.ts`): `*`, lists,
 * ranges, steps, month and day names, the Vixie day-of-month/day-of-week OR
 * rule. Also the plain form `every <n>m|h|d`. No dependency.
 */
export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function names(field: string, table: string[], offset: number): string {
  return field.replace(/[a-z]{3}/gi, (m) => {
    const i = table.indexOf(m.toLowerCase());
    if (i < 0) throw new Error(`Unknown name "${m}"`);
    return String(i + offset);
  });
}

function parseField(
  raw: string,
  lo: number,
  hi: number,
  what: string,
): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Bad ${what} "${part}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`Bad ${what} step "${part}"`);
    let a = lo;
    let b = hi;
    if (m[1] !== '*') {
      const [x, y] = m[1].split('-').map(Number);
      a = x;
      b = y === undefined ? (m[2] ? hi : x) : y;
    }
    if (a < lo || b > hi || a > b)
      throw new Error(`${what} "${part}" is out of ${lo}–${hi}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** `every 10m`, `every 2h`, `every 1d` → a cron expression. */
export function normalizeSchedule(expr: string): string {
  const e = expr.trim();
  const m = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i.exec(e);
  if (!m) return e;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase()[0];
  if (n < 1) throw new Error('every: the count must be at least 1');
  if (unit === 'm') {
    if (n > 59) throw new Error('every: minutes go up to 59; use hours');
    return `*/${n} * * * *`;
  }
  if (unit === 'h') {
    if (n > 23) throw new Error('every: hours go up to 23; use days');
    return `0 */${n} * * *`;
  }
  if (n > 28) throw new Error('every: days go up to 28');
  return `0 0 */${n} * *`;
}

export function parseCron(expr: string): CronFields {
  const parts = normalizeSchedule(expr).split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      'A schedule is five cron fields (minute hour day month weekday) or "every <n>m|h|d"',
    );
  const [mi, h, d, mo, w] = parts;
  const dow = parseField(
    names(w, DAYS, 0).replace(/\b7\b/g, '0'),
    0,
    6,
    'weekday',
  );
  return {
    minute: parseField(mi, 0, 59, 'minute'),
    hour: parseField(h, 0, 23, 'hour'),
    dom: parseField(d, 1, 31, 'day'),
    month: parseField(names(mo, MONTHS, 1), 1, 12, 'month'),
    dow,
    domAny: d === '*',
    dowAny: w === '*',
  };
}

function matchesDay(f: CronFields, t: Date): boolean {
  const dom = f.dom.has(t.getUTCDate());
  const dow = f.dow.has(t.getUTCDay());
  if (f.domAny && f.dowAny) return true;
  if (f.domAny) return dow;
  if (f.dowAny) return dom;
  return dom || dow;
}

/** The first UTC minute strictly after `after` that matches; null within four years. */
export function nextCron(expr: string | CronFields, after: Date): Date | null {
  const f = typeof expr === 'string' ? parseCron(expr) : expr;
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 4 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!f.month.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(f, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hour.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!f.minute.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

/** Whether `expr` parses; the message says what is wrong. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
