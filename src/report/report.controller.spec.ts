import {
  GUARDS_METADATA,
  PATH_METADATA,
  METHOD_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthGuard } from '../common/guards/auth.guard';
import { ReportAdminController } from './report.controller';

describe('ReportAdminController', () => {
  it('serves GET /admin/reports/summary behind sign-in and the admin guard', async () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReportAdminController)).toBe(
      'admin',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, ReportAdminController)).toEqual(
      [AuthGuard, AdminGuard],
    );
    const handler = ReportAdminController.prototype.reportSummary;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('reports/summary');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );

    const summary = { open: 1, resolvedLast30d: 0, takenDown: 0 };
    const controller = new ReportAdminController(
      { summary: jest.fn(async () => summary) } as never,
      {} as never,
    );
    await expect(controller.reportSummary()).resolves.toBe(summary);
  });

  it('the admin guard refuses an ordinary account', () => {
    const context = (role: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ account: { role } }) }),
      }) as never;
    expect(() => new AdminGuard().canActivate(context('user'))).toThrow(
      ForbiddenException,
    );
    expect(new AdminGuard().canActivate(context('admin'))).toBe(true);
  });
});
