import { Injectable } from '@nestjs/common';

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const sesClient = new SESv2Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

@Injectable()
export class EmailService {
  async send(params) {
    const emailCommand = new SendEmailCommand({
      FromEmailAddress: 'The Keeper <keeper@crux.garden>',
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
    return sesClient.send(emailCommand);
  }
}
