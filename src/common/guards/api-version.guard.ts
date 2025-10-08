import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
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

    // Check if requested version is supported
    if (!this.supportedVersions.includes(clientVersion)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.BAD_REQUEST,
          message: `API version ${clientVersion} is not supported`,
          supportedVersions: this.supportedVersions,
          currentVersion: this.currentVersion,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Store the requested version on the request for use in controllers
    request.apiVersion = clientVersion;
    return true;
  }
}
