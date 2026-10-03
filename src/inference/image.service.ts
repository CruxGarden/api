import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import OpenAI, { toFile } from 'openai';
import type { Response } from 'express';
import { BillingService } from '../billing/billing.service';
import { LoggerService } from '../common/services/logger.service';
import { InferenceRepository, ReservationError } from './inference.repository';
import { ALLOWANCES } from './policy';
import {
  IMAGE_MODEL,
  IMAGE_RESERVATION,
  imageBytes,
  imageCost,
  validateImageRequest,
} from './image-policy';

export function includedImagesAvailable(): boolean {
  return (
    process.env.INCLUDED_INFERENCE_ENABLED === '1' &&
    !!process.env.INCLUDED_OPENAI_API_KEY
  );
}
@Injectable()
export class IncludedImageService {
  private readonly logger: LoggerService;
  constructor(
    private readonly repo: InferenceRepository,
    private readonly billing: BillingService,
    logger: LoggerService,
  ) {
    this.logger = logger.createChildLogger('IncludedImageService');
  }
  private provider(): OpenAI {
    if (!includedImagesAvailable())
      throw new ServiceUnavailableException(
        'Included images are temporarily unavailable. Please try again shortly.',
      );
    return new OpenAI({
      apiKey: process.env.INCLUDED_OPENAI_API_KEY,
      maxRetries: 0,
      timeout: 300_000,
    });
  }
  async generate(
    accountId: string,
    requestId: string,
    value: unknown,
    res: Response,
  ): Promise<void> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestId || '',
      )
    )
      throw new BadRequestException('Supply a UUID request ID.');
    const body = validateImageRequest(value);
    const limit = ALLOWANCES[await this.billing.planIdFor(accountId)];
    if (!limit)
      throw new HttpException('Included images require a Gardener plan.', 402);
    const provider = this.provider();
    const reservation = await this.repo.reserve(
      accountId,
      requestId,
      [{ model: IMAGE_MODEL, amount: IMAGE_RESERVATION }],
      limit,
    );
    if (reservation.error instanceof ReservationError) {
      const reason = reservation.error.reason;
      throw new HttpException(
        reason === 'duplicate'
          ? 'This image request was already submitted. Check its result before starting another.'
          : reason === 'concurrent'
            ? 'Two included requests are running. Wait for one to finish.'
            : 'There is not enough included allowance for this image. Check your allowance and try later.',
        reason === 'duplicate' ? 409 : 429,
      );
    }
    if (reservation.error || !reservation.data)
      throw new ServiceUnavailableException(
        'Could not reserve image allowance. Please try again.',
      );
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 300_000);
    const closed = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', closed);
    let started = false;
    let settled: ReturnType<typeof imageCost> = null;
    try {
      if (res.destroyed) return;
      const options = {
        model: IMAGE_MODEL,
        prompt: body.prompt,
        size: body.size,
        quality: 'medium' as const,
        n: 1,
        output_format: 'png' as const,
      };
      const reference = body.image
        ? await toFile(imageBytes(body.image), 'reference.png', {
            type: 'image/png',
          })
        : null;
      if (abort.signal.aborted) return;
      started = true;
      const output = reference
        ? await provider.images.edit(
            { ...options, image: reference },
            { signal: abort.signal },
          )
        : await provider.images.generate(options, { signal: abort.signal });
      settled = imageCost(output.usage);
      const image = output.data?.[0]?.b64_json;
      if (!image) throw new Error('No image returned');
      imageBytes(image);
      if (!res.destroyed) res.setHeader('Cache-Control', 'no-store');
      if (!res.destroyed)
        res.json({
          image,
          mimeType: 'image/png',
          model: IMAGE_MODEL,
          requestId,
        });
    } catch (error) {
      // Only explicit provider rejection proves no generation began. Timeouts,
      // aborts and 5xx outcomes remain reserved; never automatically replay them.
      if (
        error instanceof OpenAI.APIError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500
      )
        started = false;
      if (!res.destroyed)
        throw new ServiceUnavailableException(
          started
            ? 'Image generation was interrupted. Check your allowance before trying again; the request may have used allowance.'
            : 'The image could not be generated. Try a different description. No image allowance was used.',
        );
    } finally {
      clearTimeout(timeout);
      res.off('close', closed);
      abort.abort();
      const result = await this.repo.settle(
        accountId,
        requestId,
        settled?.amount ?? (started ? IMAGE_RESERVATION : 0),
        settled
          ? {
              input: settled.input,
              output: settled.output,
              cacheRead: 0,
              cacheWrite: 0,
            }
          : null,
        settled ? 'complete' : started ? 'uncertain' : 'rejected',
      );
      if (result.error)
        this.logger.error(
          'Image settlement failed; reservation retained',
          undefined,
          { accountId, requestId },
        );
    }
  }
}
