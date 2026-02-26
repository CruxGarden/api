import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { version } from '../../../package.json';

@Injectable()
export class ApiVersionGuard implements CanActivate {
  private readonly supportedVersions = ['0.0.1']; // Add all supported versions here
  private readonly currentVersion = version;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const clientVersion =
      request.headers['api-version'] || request.headers['API-VERSION'];

    // If no version specified, assume current version
    if (!clientVersion) {
      request.apiVersion = this.currentVersion;
      return true;
    }

    // Log unsupported versions but don't block (disabled for now)
    if (!this.supportedVersions.includes(clientVersion)) {
      console.warn(
        `[ApiVersionGuard] Unsupported api-version: ${clientVersion} (supported: ${this.supportedVersions.join(', ')})`,
      );
    }

    // Store the requested version on the request for use in controllers
    request.apiVersion = clientVersion;
    return true;
  }
}
