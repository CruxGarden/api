import { Request } from 'express';
import { MulterError, StorageEngine } from 'multer';
import { MAX_PUBLISH_FILES, MAX_PUBLISH_SIZE } from '../types/constants';

export const publishUploadLimits = {
  fileSize: MAX_PUBLISH_SIZE,
  files: MAX_PUBLISH_FILES,
  fields: 1, // One JSON metadata field; file bytes have their own aggregate budget.
  fieldSize: 4 * 1024 * 1024,
  fieldNameSize: 100,
};

/** Count bytes as they arrive, before retaining them. Downstream publication
 * currently needs Buffers, so the entire request shares one bounded budget. */
export function publishUploadStorage(
  maxBytes = MAX_PUBLISH_SIZE,
): StorageEngine {
  const budgets = new WeakMap<Request, { bytes: number; exceeded: boolean }>();
  return {
    _handleFile(req, file, callback) {
      let budget = budgets.get(req);
      if (!budget) {
        budget = { bytes: 0, exceeded: false };
        budgets.set(req, budget);
      }
      const requestBudget = budget;
      let chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      file.stream.on('data', (chunk: Buffer) => {
        if (finished) return;
        if (
          requestBudget.exceeded ||
          chunk.length > maxBytes - requestBudget.bytes
        ) {
          requestBudget.exceeded = true;
          finished = true;
          chunks = [];
          callback(new MulterError('LIMIT_FILE_SIZE', file.fieldname));
          return;
        }
        requestBudget.bytes += chunk.length;
        size += chunk.length;
        chunks.push(chunk);
      });
      file.stream.once('end', () => {
        if (finished) return;
        finished = true;
        const buffer = Buffer.concat(chunks, size);
        chunks = [];
        callback(null, { buffer, size });
      });
      file.stream.once('error', () => {
        // Multer owns stream-error propagation and its pending-write counter.
        finished = true;
        chunks = [];
      });
    },
    _removeFile(_req, file, callback) {
      delete file.buffer;
      // Multer removes files serially. Synchronous callbacks overflow the stack
      // when rejecting a complete tool with thousands of parts.
      setImmediate(() => callback(null));
    },
  };
}
