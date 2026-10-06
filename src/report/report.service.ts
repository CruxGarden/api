import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Knex } from 'knex';
import { toEntityFields } from '../common/helpers/case-helpers';
import { EmailService } from '../common/services/email.service';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { CruxService } from '../crux/crux.service';
import Crux from '../crux/entities/crux.entity';
import Takedown from '../crux/entities/takedown.entity';
import TakedownRaw from '../crux/entities/takedown-raw.entity';
import { CreateReportDto } from './dto/create-report.dto';
import { CreateTakedownDto } from './dto/create-takedown.dto';
import { ReportStatus, UpdateReportDto } from './dto/update-report.dto';
import Report from './entities/report.entity';
import ReportRaw from './entities/report-raw.entity';
import { ReportRepository, ReportSummary } from './report.repository';

export const NOT_PUBLISHED = 'This creation is not published';
export const NO_REPORT_RECIPIENT =
  'Reports have no recipient: set REPORTS_NOTIFY_EMAIL (or create an admin account). Reports are still stored at GET /admin/reports.';
const DAY_MS = 24 * 60 * 60 * 1000;

/** `a@x, b@y` → the addresses that look like addresses. */
function emailList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((email) => email.trim())
    .filter((email) => /^[^\s@]+@[^\s@]+$/.test(email));
}

@Injectable()
export class ReportService implements OnApplicationBootstrap {
  private readonly logger: LoggerService;

  constructor(
    private readonly reportRepository: ReportRepository,
    private readonly cruxService: CruxService,
    private readonly emailService: EmailService,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('ReportService');
  }

  asReport(data: ReportRaw): Report {
    return new Report(toEntityFields(data));
  }

  /**
   * Same salt as the usage visitor tokens, but not per-day: the operator can
   * see that several reports came from one place without ever holding the IP.
   */
  private ipHash(ip?: string): string | undefined {
    if (!ip) return undefined;
    const salt = process.env.USAGE_VISITOR_SALT || process.env.JWT_SECRET || '';
    return createHash('sha256')
      .update(`${salt}|report|${ip}`)
      .digest('base64url')
      .slice(0, 22);
  }

  async create(dto: CreateReportDto, ip?: string): Promise<Report> {
    // Only what is live right now can be reported; an unknown id, a private
    // sync copy and a taken-down crux all answer the same way.
    let crux: Crux;
    try {
      crux = await this.cruxService.findById(dto.cruxId);
    } catch (error) {
      if (error instanceof NotFoundException)
        throw new NotFoundException(NOT_PUBLISHED);
      throw error;
    }
    if (!crux.meta?.publishedAt) throw new NotFoundException(NOT_PUBLISHED);

    const { data, error } = await this.reportRepository.create({
      id: this.keyMaster.generateId(),
      cruxId: crux.id,
      authorId: crux.authorId,
      cruxSlug: crux.slug,
      cruxTitle: crux.title,
      reason: dto.reason,
      details: dto.details,
      reporterEmail: dto.email?.toLowerCase(),
      reporterIpHash: this.ipHash(ip),
    });
    if (error)
      throw new InternalServerErrorException('Report error', { cause: error });

    const report = this.asReport(data);
    this.logger.info('Report received', {
      reportId: report.id,
      cruxId: report.cruxId,
      reason: report.reason,
    });
    await this.notifyOperator(report);
    return report;
  }

  /**
   * Who hears about a report: `REPORTS_NOTIFY_EMAIL` (comma-separated), else
   * the configured operator `BOOTSTRAP_ADMIN_EMAIL`, else the live admin
   * accounts. Never throws; an unreadable account list means no fallback.
   */
  async recipients(): Promise<string[]> {
    const configured = emailList(process.env.REPORTS_NOTIFY_EMAIL);
    if (configured.length) return configured;
    const bootstrap = emailList(process.env.BOOTSTRAP_ADMIN_EMAIL);
    if (bootstrap.length) return bootstrap;
    try {
      const { data, error } = await this.reportRepository.operatorEmails();
      if (error) throw error;
      return data ?? [];
    } catch (error) {
      this.logger.error('Could not read operator accounts', error as Error);
      return [];
    }
  }

  /** Say so at startup when a report would reach no one (CR08). */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (!(await this.recipients()).length)
      this.logger.warn(NO_REPORT_RECIPIENT);
  }

  async summary(now = new Date()): Promise<ReportSummary> {
    const { data, error } = await this.reportRepository.summary(
      new Date(now.getTime() - 30 * DAY_MS),
    );
    if (error || !data)
      throw new InternalServerErrorException('Report error', { cause: error });
    return data;
  }

  /** The report is already saved; a failed notice must not fail the request. */
  private async notifyOperator(report: Report): Promise<void> {
    const recipients = await this.recipients();
    if (!recipients.length) {
      this.logger.warn(NO_REPORT_RECIPIENT, { reportId: report.id });
      return;
    }
    for (const to of recipients) await this.sendNotice(to, report);
  }

  private async sendNotice(to: string, report: Report): Promise<void> {
    try {
      await this.emailService.send({
        email: to,
        subject: `Report (${report.reason}): ${report.cruxTitle || report.cruxSlug || report.cruxId}`,
        body: [
          `A published creation was reported as "${report.reason}".`,
          '',
          `Crux: ${report.cruxTitle || '(untitled)'} — ${report.cruxId}`,
          `Published at: https://${report.cruxId}.publish.crux.garden`,
          `Author id: ${report.authorId || '(unknown)'}`,
          `Reporter: ${report.reporterEmail || '(no email given)'}`,
          '',
          report.details || '(no details given)',
          '',
          `Report id: ${report.id}`,
        ].join('\n'),
      });
    } catch (error) {
      this.logger.error('Report notification failed', error as Error, {
        reportId: report.id,
      });
    }
  }

  findAllQuery(
    status?: ReportStatus,
  ): Knex.QueryBuilder<ReportRaw, ReportRaw[]> {
    return this.reportRepository.findAllQuery(status);
  }

  async update(
    id: string,
    dto: UpdateReportDto,
    operatorId: string,
  ): Promise<Report> {
    const existing = await this.reportRepository.findById(id);
    if (existing.error)
      throw new InternalServerErrorException('Report error', {
        cause: existing.error,
      });
    if (!existing.data) throw new NotFoundException('Report not found');

    const { data, error } = await this.reportRepository.update(id, {
      status: dto.status,
      resolutionNote: dto.resolutionNote,
      resolvedBy: operatorId,
    });
    if (error || !data)
      throw new InternalServerErrorException('Report error', { cause: error });
    return this.asReport(data);
  }

  /** Unpublish through the crux's own path, then close what the takedown answers. */
  async takeDown(
    dto: CreateTakedownDto,
    operatorId: string,
  ): Promise<Takedown> {
    const takedown = await this.cruxService.takeDownCrux(
      dto.cruxId,
      operatorId,
      dto.reason,
      dto.reportId,
    );
    const { error } = await this.reportRepository.resolveOpenForCrux(
      dto.cruxId,
      {
        status: 'resolved',
        resolutionNote: `Taken down: ${dto.reason}`,
        resolvedBy: operatorId,
      },
    );
    // The takedown stands; the reports can be closed by hand.
    if (error)
      this.logger.error('Could not resolve reports after takedown', error, {
        cruxId: dto.cruxId,
      });
    return takedown;
  }

  liftTakedown(cruxId: string, operatorId: string): Promise<Takedown> {
    return this.cruxService.liftTakedown(cruxId, operatorId);
  }

  findTakedownsQuery(
    activeOnly: boolean,
  ): Knex.QueryBuilder<TakedownRaw, TakedownRaw[]> {
    return this.cruxService.findTakedownsQuery(activeOnly);
  }
}
