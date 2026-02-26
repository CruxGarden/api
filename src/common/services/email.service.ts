import { Injectable } from '@nestjs/common';
import { LoggerService } from './logger.service';

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

@Injectable()
export class EmailService {
  private readonly logger: LoggerService;
  private readonly mockMode: boolean;
  private readonly sesClient: any;

  constructor(private readonly loggerService: LoggerService) {
    this.logger = this.loggerService.createChildLogger('EmailService');

    this.mockMode = !this.hasAwsCredentials();
    if (this.mockMode) {
      this.logger.warn(
        'AWS credentials not found - EmailService running in mock mode (logging only)',
      );
    } else {
      this.sesClient = new SESv2Client({
        region: process.env.AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      });
    }
  }

  private hasAwsCredentials(): boolean {
    const placeholders = ['dummy', 'your-key', 'your-secret', ''];
    const key = process.env.AWS_ACCESS_KEY_ID ?? '';
    const secret = process.env.AWS_SECRET_ACCESS_KEY ?? '';
    const region = process.env.AWS_REGION ?? '';
    const from = process.env.AWS_SES_FROM_EMAIL ?? '';

    if (!key || !secret || !region || !from) return false;
    if (placeholders.includes(key) || placeholders.includes(secret))
      return false;

    return true;
  }

  async send(params) {
    if (this.mockMode) {
      this.logger.info('Email sent', {
        from: process.env.AWS_SES_FROM_EMAIL || 'noreply@example.com',
        to: params.email,
        subject: params.subject,
        body: params.body,
      });
      return null;
    }

    const emailCommand = new SendEmailCommand({
      FromEmailAddress: process.env.AWS_SES_FROM_EMAIL,
      Destination: {
        ToAddresses: [params.email],
      },
      Content: {
        Simple: {
          Subject: {
            Data: params.subject,
          },
          Body: {
            Text: {
              Data: params.body,
            },
          },
        },
      },
    });

    return this.sesClient.send(emailCommand);
  }
}
