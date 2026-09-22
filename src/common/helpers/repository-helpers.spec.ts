import { runInNewContext } from 'vm';
import { toError } from './repository-helpers';

describe('repository error normalization', () => {
  it('preserves a native driver constraint code across JavaScript realms', () => {
    const foreign = runInNewContext(
      'Object.assign(new Error("unique constraint"), { code: "SQLITE_CONSTRAINT_UNIQUE" })',
    );
    expect(foreign).not.toBeInstanceOf(Error);
    expect(toError(foreign)).toMatchObject({
      message: 'unique constraint',
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    expect(toError(foreign)).toBeInstanceOf(Error);
  });

  it('retains same-realm errors and normalizes non-error failures', () => {
    const error = new Error('failure');
    expect(toError(error)).toBe(error);
    expect(toError(null).message).toBe('null');
    expect(toError('failed').message).toBe('failed');
  });
});
