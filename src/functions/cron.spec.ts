import { nextCron, parseCron } from './cron';

describe('Function schedule weekday aliases', () => {
  it('expands ranges before normalizing Sunday', () => {
    expect([...parseCron('0 9 * * 5-7').dow]).toEqual([5, 6, 0]);
    expect([...parseCron('0 9 * * 0-7').dow]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(nextCron('0 9 * * 5-7', new Date('2026-09-19T10:00:00Z'))).toEqual(
      new Date('2026-09-20T09:00:00Z'),
    );
  });

  it('keeps a step of seven intact', () => {
    expect([...parseCron('0 9 * * */7').dow]).toEqual([0]);
    expect([...parseCron('0 9 * * 7').dow]).toEqual([0]);
  });
});
