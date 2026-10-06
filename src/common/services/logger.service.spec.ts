import { InternalServerErrorException } from '@nestjs/common';
import { LoggerService } from './logger.service';

describe('server error diagnostics', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retains the original cause and driver code when a service wraps a failure', () => {
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    const driver = Object.assign(new Error('database unavailable'), {
      code: '08006',
    });
    const error = new InternalServerErrorException('Could not load Crux', {
      cause: driver,
    });
    new LoggerService().error('Request failed', error);
    const message = output.mock.calls[0][0] as string;
    expect(message).toContain('Could not load Crux');
    expect(message).toContain('database unavailable');
    expect(message).toContain('08006');
  });

  it('bounds cyclic causes so logging cannot fail while handling an error', () => {
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('outer'), {
      cause: undefined as unknown,
    });
    const inner = Object.assign(new Error('inner'), { cause: error });
    error.cause = inner;
    expect(() =>
      new LoggerService().error('Request failed', error),
    ).not.toThrow();
    expect(output.mock.calls[0][0]).toContain('inner');
    expect(output).toHaveBeenCalledTimes(1);
  });
});
