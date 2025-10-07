import { Injectable } from '@nestjs/common';
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
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AccountRepository');
    this.logger.debug('AccountRepository initialized');
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

  async delete(accountId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
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
}
