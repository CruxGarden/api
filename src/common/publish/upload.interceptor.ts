import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { MulterError } from 'multer';
import { receivePublishUpload } from './upload-storage';

@Injectable()
export class PublishUploadInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    try {
      await receivePublishUpload(http.getRequest(), http.getResponse());
    } catch (error) {
      if (error instanceof MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE')
          throw new PayloadTooLargeException('Publish upload is too large.', {
            cause: error,
          });
        throw new BadRequestException('Invalid publish upload.', {
          cause: error,
        });
      }
      // Parser failures are malformed client input; unexpected storage failures
      // retain their server-error semantics and cause for diagnostics.
      if (
        error instanceof Error &&
        /^(Multipart:|Unexpected end of form|Malformed part header)/.test(
          error.message,
        )
      )
        throw new BadRequestException('Invalid multipart upload.', {
          cause: error,
        });
      throw error;
    }
    return next.handle();
  }
}
