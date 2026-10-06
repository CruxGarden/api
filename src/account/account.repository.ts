import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { success, failure } from '../common/helpers/repository-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { RepositoryResponse } from '../common/types/interfaces';
import AccountRaw from './entities/account-raw.entity';

@Injectable()
export class AccountRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AccountRepository');
  }

  private static readonly TABLE_NAME = 'accounts';
  private static readonly BASE_SELECT = '*';

  async findById(id: string): Promise<RepositoryResponse<AccountRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<AccountRaw>(AccountRepository.TABLE_NAME)
        .select(AccountRepository.BASE_SELECT)
        .where('id', id)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async findByEmail(email: string): Promise<RepositoryResponse<AccountRaw>> {
    try {
      const found = await this.dbService
        .query()
        .from<AccountRaw>(AccountRepository.TABLE_NAME)
        .select(AccountRepository.BASE_SELECT)
        .where('email', email)
        .whereNull('deleted')
        .first();

      return success(found);
    } catch (error) {
      return failure(error);
    }
  }

  async create(
    createData: CreateAccountDto,
  ): Promise<RepositoryResponse<AccountRaw>> {
    try {
      const tableFields = toTableFields(createData);

      await this.dbService
        .query()
        .from<AccountRaw>(AccountRepository.TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const created = await this.dbService
        .query()
        .from<AccountRaw>(AccountRepository.TABLE_NAME)
        .select(AccountRepository.BASE_SELECT)
        .where('id', createData.id)
        .first();

      return success(created);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    accountId: string,
    updateData: UpdateAccountDto,
  ): Promise<RepositoryResponse<AccountRaw>> {
    try {
      const tableFields = toTableFields(updateData);

      await this.dbService
        .query()
        .from<AccountRaw>(AccountRepository.TABLE_NAME)
        .where('id', accountId)
        .update({
          ...tableFields,
          updated: new Date(),
        });

      const updated = await this.dbService
        .query()
        .from<AccountRaw>(AccountRepository.TABLE_NAME)
        .select(AccountRepository.BASE_SELECT)
        .where('id', accountId)
        .first();

      return success(updated);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(
    accountId: string,
    trx?: Knex.Transaction,
  ): Promise<RepositoryResponse<void>> {
    try {
      const query = trx || this.dbService.query();

      await query
        .from<AccountRaw>(AccountRepository.TABLE_NAME)
        .where('id', accountId)
        .update({
          deleted: new Date(),
          updated: new Date(),
        });

      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  }

  /** Operator hold (ADR 0083). Returns the updated row, or null for no live account. */
  async setSuspension(
    accountId: string,
    hold: { reason: string; operatorId: string } | null,
  ): Promise<RepositoryResponse<AccountRaw | null>> {
    try {
      const changed = await this.dbService
        .query()
        .from<AccountRaw>(AccountRepository.TABLE_NAME)
        .where('id', accountId)
        .whereNull('deleted')
        .update(
          hold
            ? {
                suspended: new Date(),
                suspended_reason: hold.reason,
                suspended_by: hold.operatorId,
                updated: new Date(),
              }
            : {
                suspended: null,
                suspended_reason: null,
                suspended_by: null,
                updated: new Date(),
              },
        );
      if (!changed) return success(null);
      return this.findById(accountId);
    } catch (error) {
      return failure(error);
    }
  }

  /** Admin lookup by email or username; minimal fields, newest first. */
  async search(
    query: string,
    limit = 50,
  ): Promise<RepositoryResponse<AccountSearchRow[]>> {
    try {
      const db = this.dbService.query();
      const q = db
        .from('accounts as a')
        .leftJoin('authors as au', function () {
          this.on('au.account_id', '=', 'a.id').andOnNull('au.deleted');
        })
        .whereNull('a.deleted')
        .select(
          'a.id',
          'a.email',
          'a.role',
          'a.created',
          'a.suspended',
          'a.suspended_reason',
          'au.username',
        )
        .orderBy('a.created', 'desc')
        .limit(limit);
      const term = query.trim().toLowerCase().replace(/^@/, '');
      if (term) {
        const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q.where(function () {
          this.whereRaw("lower(a.email) like ? escape '\\'", [like]).orWhereRaw(
            "lower(au.username) like ? escape '\\'",
            [like],
          );
        });
      }
      return success((await q) as AccountSearchRow[]);
    } catch (error) {
      return failure(error);
    }
  }
}

export interface AccountSearchRow {
  id: string;
  email: string;
  role: string;
  created: Date;
  suspended: Date | null;
  suspended_reason: string | null;
  username: string | null;
}
