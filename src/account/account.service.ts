import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { toEntityFields } from '../common/helpers/case-helpers';
import { KeyMaster } from '../common/services/key.master';
import { DELETE_CONFIRMATION_TEXT } from '../common/types/constants';
import { LoggerService } from '../common/services/logger.service';
import { DbService } from '../common/services/db.service';
import { RedisService } from '../common/services/redis.service';
import { AccountRepository } from './account.repository';
import { AuthorRepository } from '../author/author.repository';
import { CruxRepository } from '../crux/crux.repository';
import { ThemeRepository } from '../theme/theme.repository';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import Account from './entities/account.entity';
import AccountRaw from './entities/account-raw.entity';

@Injectable()
export class AccountService {
  private readonly logger: LoggerService;

  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly authorRepository: AuthorRepository,
    private readonly cruxRepository: CruxRepository,
    private readonly themeRepository: ThemeRepository,
    private readonly dbService: DbService,
    private readonly redisService: RedisService,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AccountService');
  }

  grantEmailKey(email: string): string {
    return `crux:auth:grant:email:${email}`;
  }

  grantIdKey(grantId: string): string {
    return `crux:auth:grant:id:${grantId}`;
  }

  asAccount(data: AccountRaw): Account {
    const entityFields = toEntityFields(data);
    return new Account(entityFields);
  }

  asAccounts(rows: AccountRaw[]): Account[] {
    return rows.map((data) => this.asAccount(data));
  }

  async findById(accountId: string): Promise<Account> {
    const found = await this.accountRepository.findById(accountId);
    if (found.error)
      throw new InternalServerErrorException(`database error: ${found.error}`);
    if (!found.data) throw new NotFoundException('Account not found');

    return this.asAccount(found.data);
  }

  same(a: string, b: string) {
    return a?.toLowerCase() === b?.toLowerCase();
  }

  formatEmail(email: string): string {
    return email?.toLowerCase()?.trim() || '';
  }

  async get(accountId: string): Promise<Account> {
    return this.findById(accountId);
  }

  async findByEmail(email: string): Promise<Account | null> {
    const formattedEmail = this.formatEmail(email);
    const found = await this.accountRepository.findByEmail(formattedEmail);
    if (found.error)
      throw new InternalServerErrorException(`Database error: ${found.error}`);

    return found.data ? this.asAccount(found.data) : null;
  }

  async create(createAccountDto: CreateAccountDto): Promise<Account> {
    createAccountDto.email = this.formatEmail(createAccountDto.email);
    createAccountDto.id = createAccountDto.id || this.keyMaster.generateId();
    createAccountDto.key = createAccountDto.key || this.keyMaster.generateKey();

    // 1) check if email already exists
    const existing = await this.findByEmail(createAccountDto.email);
    if (existing) {
      throw new ConflictException('Email already in use');
    }

    // 2) create account
    const created = await this.accountRepository.create(createAccountDto);
    if (created.error) {
      throw new InternalServerErrorException(
        `Account creation error: ${created.error}`,
      );
    }

    return this.asAccount(created.data);
  }

  async update(
    accountId: string,
    updateAccountDto: UpdateAccountDto,
  ): Promise<Account> {
    // 1) fetch account
    const accountToUpdate = await this.findById(accountId);

    // 2) format email if being updated
    if (updateAccountDto.email) {
      updateAccountDto.email = this.formatEmail(updateAccountDto.email);
    }

    // 3) if new email, check if already being used by another account
    const emailChanged =
      updateAccountDto.email &&
      !this.same(updateAccountDto.email, accountToUpdate.email);

    if (emailChanged) {
      const accountUsingEmail = await this.findByEmail(updateAccountDto.email);
      if (accountUsingEmail) {
        throw new ConflictException('Email in use by another account');
      }
    }

    // 4) update account
    const updated = await this.accountRepository.update(
      accountToUpdate.id,
      updateAccountDto,
    );
    if (updated.error) {
      throw new InternalServerErrorException(
        `Account update error: ${updated.error}`,
      );
    }

    // 5) if email changed, invalidate tokens (requires re-login)
    if (emailChanged) {
      // Invalidate the grant for the old email
      const grantId = await this.redisService.get(
        this.grantEmailKey(accountToUpdate.email),
      );
      if (grantId) {
        await this.redisService.del(this.grantEmailKey(accountToUpdate.email));
        await this.redisService.del(this.grantIdKey(grantId.toString()));
      }
      this.logger.info('Invalidated tokens after email change', {
        accountId: accountToUpdate.id,
        oldEmail: accountToUpdate.email,
        newEmail: updateAccountDto.email,
      });
    }

    return this.asAccount(updated.data);
  }

  async delete(
    accountId: string,
    deleteAccountDto: DeleteAccountDto,
  ): Promise<null> {
    // 1) fetch account
    const accountToDelete = await this.findById(accountId);

    // 2) verify confirmation text
    if (deleteAccountDto.confirmationText !== DELETE_CONFIRMATION_TEXT) {
      throw new BadRequestException('Confirmation text does not match');
    }

    // 3) Get author for this account (to find their content)
    const authorResult = await this.authorRepository.findBy(
      'account_id',
      accountToDelete.id,
    );
    if (authorResult.error) {
      throw new InternalServerErrorException(
        `Error fetching author: ${authorResult.error}`,
      );
    }

    // 4) Cascade delete all associated data in a transaction
    const trx = await this.dbService.query().transaction();

    try {
      // If account has an author, delete all their content
      if (authorResult.data) {
        const author = authorResult.data;

        // Get all cruxes by this author
        const cruxesResult = await this.cruxRepository.findAllByAuthorId(
          author.id,
        );
        if (cruxesResult.error) {
          throw new InternalServerErrorException(
            `Error fetching cruxes: ${cruxesResult.error}`,
          );
        }

        // Delete each crux (which also deletes associated dimensions)
        if (cruxesResult.data && cruxesResult.data.length > 0) {
          for (const crux of cruxesResult.data) {
            const deleteCruxResult = await this.cruxRepository.delete(
              crux.id,
              trx,
            );
            if (deleteCruxResult.error) {
              throw new InternalServerErrorException(
                `Error deleting crux: ${deleteCruxResult.error}`,
              );
            }
          }
        }

        // Delete all themes by this author
        const deleteThemesResult = await this.themeRepository.deleteByAuthorId(
          author.id,
          trx,
        );
        if (deleteThemesResult.error) {
          throw new InternalServerErrorException(
            `Error deleting themes: ${deleteThemesResult.error}`,
          );
        }
      }

      // Delete all authors for this account
      const deleteAuthorsResult = await this.authorRepository.deleteByAccountId(
        accountToDelete.id,
        trx,
      );
      if (deleteAuthorsResult.error) {
        throw new InternalServerErrorException(
          `Error deleting authors: ${deleteAuthorsResult.error}`,
        );
      }

      // Delete the account
      const deleteAccountResult = await this.accountRepository.delete(
        accountToDelete.id,
        trx,
      );
      if (deleteAccountResult.error) {
        throw new InternalServerErrorException(
          `Error deleting account: ${deleteAccountResult.error}`,
        );
      }

      // Commit the transaction
      await trx.commit();

      return null;
    } catch (error) {
      // Rollback on any error
      await trx.rollback();
      throw error;
    }
  }
}
