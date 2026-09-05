import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../common/guards/auth.guard';
import { OptionalAuthGuard } from '../common/guards/optional-auth.guard';
import { AuthRequest } from '../common/types/interfaces';
import { CruxService } from '../crux/crux.service';
import { AuthorService } from '../author/author.service';
import { StoreService } from './crux-store.service';
import { StoreSwagger } from './crux-store.swagger';
import { UsageService } from '../usage/usage.service';
import {
  SetStoreEntryDto,
  IncrementStoreEntryDto,
} from './dto/set-store-entry.dto';

@Controller('store')
@StoreSwagger.Controller()
export class StoreController {
  constructor(
    private readonly storeService: StoreService,
    private readonly cruxService: CruxService,
    private readonly authorService: AuthorService,
    private readonly usage: UsageService,
  ) {}

  /**
   * Resolve the crux author ID from a crux ID.
   * Every store operation needs the author ID for billing.
   */
  private async getCruxAuthorId(cruxId: string): Promise<string> {
    const crux = await this.cruxService.findById(cruxId);
    if (!crux) throw new NotFoundException('Crux not found');
    return crux.authorId;
  }

  /**
   * Resolve visitor's author ID from the account JWT (if present).
   */
  private async getVisitorId(req: AuthRequest): Promise<string | null> {
    if (!req.account) return null;
    try {
      const author = await this.authorService.findByAccountId(req.account.id);
      return author?.id ?? null;
    } catch {
      return null;
    }
  }

  // ── Public/visitor endpoints ────────────────────────────

  /**
   * GET /store/:cruxId/:key
   * Public and common keys: `{ value, mode, updatedAt }` for anyone.
   * Protected keys: the caller's own slot (token), else `{ value: null }`.
   */
  @Get(':cruxId/:key')
  @UseGuards(OptionalAuthGuard)
  @StoreSwagger.Get()
  async get(
    @Param('cruxId') cruxId: string,
    @Param('key') key: string,
    @Req() req: AuthRequest,
  ) {
    const visitorId = await this.getVisitorId(req);
    const entry = await this.storeService.get(cruxId, key, visitorId);
    this.usage.noteStoreRequest(cruxId, 'read');
    if (!entry) return { value: null };
    return { value: entry.value, mode: entry.mode, updatedAt: entry.updatedAt };
  }

  /**
   * PUT /store/:cruxId/:key
   * Public keys work without auth. Protected keys require a token and write
   * the caller's own slot; common keys require a token and write the one
   * shared value. A key's mode is fixed by its first write; a different mode
   * later is a 409.
   */
  @Put(':cruxId/:key')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @StoreSwagger.Set()
  async set(
    @Param('cruxId') cruxId: string,
    @Param('key') key: string,
    @Body() dto: SetStoreEntryDto,
    @Req() req: AuthRequest,
  ) {
    const authorId = await this.getCruxAuthorId(cruxId);
    const visitorId = await this.getVisitorId(req);
    const mode = dto.mode ?? 'protected';

    const entry = await this.storeService.set(
      cruxId,
      authorId,
      key,
      dto.value,
      mode,
      visitorId,
    );
    this.usage.noteStoreRequest(cruxId, 'write');
    return { value: entry.value };
  }

  /**
   * POST /store/:cruxId/:key/inc
   * Atomic increment. Public keys: the shared value, no auth needed.
   * Common keys: the shared value, token required. Protected keys: the
   * caller's own slot.
   */
  @Post(':cruxId/:key/inc')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @StoreSwagger.Increment()
  async increment(
    @Param('cruxId') cruxId: string,
    @Param('key') key: string,
    @Body() dto: IncrementStoreEntryDto,
    @Req() req: AuthRequest,
  ) {
    const authorId = await this.getCruxAuthorId(cruxId);
    const visitorId = await this.getVisitorId(req);
    const value = await this.storeService.increment(
      cruxId,
      authorId,
      key,
      dto.by ?? 1,
      visitorId,
      dto.mode,
    );
    this.usage.noteStoreRequest(cruxId, 'write');
    return { value };
  }

  /**
   * DELETE /store/:cruxId/:key
   * The crux author deletes the whole key (every slot). Anyone else deletes
   * the shared value of a public key, the shared value of a common key
   * (token required), or their own slot on a protected key (token required).
   */
  @Delete(':cruxId/:key')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @StoreSwagger.Delete()
  async deleteEntry(
    @Param('cruxId') cruxId: string,
    @Param('key') key: string,
    @Req() req: AuthRequest,
  ) {
    const authorId = await this.getCruxAuthorId(cruxId);
    const visitorId = await this.getVisitorId(req);
    if (visitorId && visitorId === authorId) {
      await this.storeService.delete(cruxId, key);
    } else {
      await this.storeService.deleteSlot(cruxId, key, visitorId);
    }
    this.usage.noteStoreRequest(cruxId, 'write');
  }

  // ── Author endpoints (full JWT required) ────────────────

  /**
   * GET /store/:cruxId
   * List all keys. Author only.
   */
  @Get(':cruxId')
  @UseGuards(AuthGuard)
  @StoreSwagger.List()
  async list(@Param('cruxId') cruxId: string, @Req() req: AuthRequest) {
    await this.assertCruxOwner(cruxId, req);
    const entries = await this.storeService.list(cruxId);
    return entries.map((e) => ({
      key: e.key,
      value: e.value,
      mode: e.mode,
      visitorId: e.visitorId,
      updatedAt: e.updatedAt,
    }));
  }

  /**
   * DELETE /store/:cruxId
   * Clear all keys. Author only.
   */
  @Delete(':cruxId')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @StoreSwagger.ClearAll()
  async clearAll(@Param('cruxId') cruxId: string, @Req() req: AuthRequest) {
    await this.assertCruxOwner(cruxId, req);
    await this.storeService.clearAll(cruxId);
  }

  // ── Helpers ─────────────────────────────────────────────

  private async assertCruxOwner(
    cruxId: string,
    req: AuthRequest,
  ): Promise<void> {
    const crux = await this.cruxService.findById(cruxId);
    if (!crux) throw new NotFoundException('Crux not found');

    const author = await this.authorService.findByAccountId(req.account.id);
    if (!author || author.id !== crux.authorId) {
      throw new ForbiddenException('You do not own this crux');
    }
  }
}
