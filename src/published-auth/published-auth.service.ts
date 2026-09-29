import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { RedisService } from '../common/services/redis.service';
import { EmailService } from '../common/services/email.service';
import { AuthService } from '../auth/auth.service';
import { AuthorService } from '../author/author.service';
import { DomainsRepository } from '../domains/domains.repository';
import { isAccountOrigin } from '../common/guards/account-origin.guard';
import { JwtPayload } from '../common/types/interfaces';

const ACCESS_SECONDS = 15 * 60;
const SESSION_SECONDS = 14 * 24 * 60 * 60;
interface Scope {
  cruxId: string;
  origin: string;
  requestOrigin: string;
}
interface Session extends Scope {
  accountId: string;
  visitor: { id: string; name: string; username: string };
  parentGrant?: string;
}
const secret = (prefix: string) =>
  prefix + randomBytes(32).toString('base64url');
const key = (token: string) =>
  'crux:published:' + createHash('sha256').update(token).digest('hex');

/** Published sessions are opaque credentials, never account JWTs or grants. */
@Injectable()
export class PublishedAuthService {
  constructor(
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly auth: AuthService,
    private readonly authors: AuthorService,
    private readonly domains: DomainsRepository,
  ) {}

  async assertPublishedOrigin(cruxId: string, origin: string): Promise<void> {
    const state = await this.domains.publishState(cruxId);
    if (state.error) throw state.error;
    if (!state.data?.published)
      throw new ForbiddenException('Crux is not published');
    if (origin === `https://${cruxId}.publish.crux.garden`) return;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new ForbiddenException('Unregistered publishing origin');
    }
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      url.port ||
      url.username ||
      url.password
    )
      throw new ForbiddenException('Unregistered publishing origin');
    const row = await this.domains.findLiveByHostname(url.hostname);
    if (row.error) throw row.error;
    if (row.data?.crux_id !== cruxId)
      throw new ForbiddenException('Unregistered publishing origin');
  }

  private async scope(cruxId: string, origin: string): Promise<Scope> {
    if (!origin) throw new ForbiddenException('Publishing origin required');
    await this.assertPublishedOrigin(cruxId, origin);
    return { cruxId, origin, requestOrigin: origin };
  }

  async code(cruxId: string, origin: string, email: string) {
    const scope = await this.scope(cruxId, origin);
    const code = secret('pc_');
    await this.redis.set(
      key(code),
      JSON.stringify({ ...scope, email: email.toLowerCase() }),
      300,
    );
    await this.email.send({
      email,
      subject: 'Sign in to a published Crux',
      body: `Your code for ${origin} is ${code}. This signs you into this creation only.`,
    });
    return { message: 'Sign-in code sent' };
  }

  async login(cruxId: string, origin: string, email: string, code: string) {
    await this.scope(cruxId, origin);
    const raw = code.startsWith('pc_') ? await this.redis.get(key(code)) : null;
    const saved = raw ? JSON.parse(raw) : null;
    if (
      !saved ||
      saved.cruxId !== cruxId ||
      saved.origin !== origin ||
      saved.email !== email.toLowerCase()
    )
      throw new UnauthorizedException('Invalid sign-in code');
    // Only one concurrent login can consume the code.
    if (!(await this.redis.take(key(code))))
      throw new UnauthorizedException('Code already used');
    const account = await this.auth.findOrCreateAccount(saved.email);
    return this.issue(saved, account.id);
  }

  async inherit(
    cruxId: string,
    origin: string,
    requestOrigin: string,
    account: JwtPayload,
  ) {
    if (!requestOrigin || !isAccountOrigin(requestOrigin))
      throw new ForbiddenException('Garden origin required');
    await this.assertPublishedOrigin(cruxId, origin);
    if (
      !account.grantId ||
      !(await this.auth.getEmailByGrantId(account.grantId))
    )
      throw new UnauthorizedException('Account session expired');
    return this.issue(
      { cruxId, origin, requestOrigin },
      account.id,
      account.grantId,
    );
  }

  private async issue(scope: Scope, accountId: string, parentGrant?: string) {
    const author = await this.authors.findByAccountId(accountId);
    const session: Session = {
      ...scope,
      accountId,
      parentGrant,
      visitor: {
        id: author.id,
        name: author.displayName,
        username: author.username,
      },
    };
    const id = secret('ps_');
    await this.redis.set(key(id), JSON.stringify(session), SESSION_SECONDS);
    return this.credentials(id, session);
  }

  private async credentials(id: string, session: Session) {
    const accessToken = secret('pv_');
    const refreshToken = secret('pr_');
    await this.redis.set(key(accessToken), id, ACCESS_SECONDS);
    await this.redis.set(key(refreshToken), id, SESSION_SECONDS);
    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_SECONDS,
      visitor: session.visitor,
    };
  }

  private async resolve(
    token: string,
    prefix: string,
    cruxId: string,
    origin: string,
  ) {
    const id = token?.startsWith(prefix)
      ? await this.redis.get(key(token))
      : null;
    const raw = id ? await this.redis.get(key(id)) : null;
    if (!raw) throw new UnauthorizedException('Published sign-in expired');
    const session: Session = JSON.parse(raw);
    if (session.cruxId !== cruxId || session.requestOrigin !== origin)
      throw new ForbiddenException(
        'Credential belongs to another Crux or origin',
      );
    await this.assertPublishedOrigin(cruxId, session.origin);
    if (
      session.parentGrant &&
      !(await this.auth.getEmailByGrantId(session.parentGrant))
    )
      throw new UnauthorizedException('Account session expired');
    return { id: id!, session };
  }

  async visitor(token: string, cruxId: string, origin: string) {
    return (await this.resolve(token, 'pv_', cruxId, origin)).session;
  }

  async refresh(token: string, cruxId: string, origin: string) {
    const { id, session } = await this.resolve(token, 'pr_', cruxId, origin);
    if (!(await this.redis.take(key(token))))
      throw new UnauthorizedException('Refresh already used');
    return this.credentials(id, session);
  }

  async logout(token: string, cruxId: string, origin: string) {
    const { id } = await this.resolve(token, 'pv_', cruxId, origin);
    await this.redis.del(key(id));
  }
}
