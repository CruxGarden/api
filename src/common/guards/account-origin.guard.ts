import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/** Account login belongs to the Garden UI. Published pages use scoped login. */
export function isAccountOrigin(origin: string | undefined): boolean {
  return (
    !origin ||
    origin === 'https://crux.garden' ||
    origin === 'crux-app://index.html' ||
    (!!process.env.CORS_ORIGIN &&
      process.env.CORS_ORIGIN !== '*' &&
      origin === process.env.CORS_ORIGIN)
  );
}

@Injectable()
export class AccountOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!isAccountOrigin(context.switchToHttp().getRequest().headers.origin))
      throw new ForbiddenException(
        'Use published Crux authentication from this origin',
      );
    return true;
  }
}
