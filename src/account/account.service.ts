import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { toEntityFields } from '../common/helpers/case-helpers';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { AccountRepository } from './account.repository';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import Account from './entities/account.entity';
import AccountRaw from './entities/account-raw.entity';

const DELETE_CONFIRMATION_TEXT = 'DELETE MY ACCOUNT';
@Injectable()
export class AccountService {
  private readonly logger: LoggerService;

  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AccountService');
    this.logger.debug('AccountService initialized');
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
    if (
      updateAccountDto.email &&
      !this.same(updateAccountDto.email, accountToUpdate.email)
    ) {
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

    // 3) delete account
    const deleted = await this.accountRepository.delete(accountToDelete.id);
    if (deleted.error) {
      throw new InternalServerErrorException(
        `Database error: ${deleted.error}`,
      );
    }

    return null;
  }
}
