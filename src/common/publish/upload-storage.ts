import { Request, Response } from 'express';
import multer = require('multer');
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
function publishUploadStorage(
  maxBytes: number,
  onOverflow: (error: MulterError) => void,
): StorageEngine {
  // One storage instance belongs to one request, shared by all its files.
  let bytes = 0;
  let exceeded = false;
  return {
    _handleFile(_req, file, callback) {
      let chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      file.stream.on('data', (chunk: Buffer) => {
        if (finished) return;
        if (exceeded || chunk.length > maxBytes - bytes) {
          exceeded = true;
          finished = true;
          chunks = [];
          const error = new MulterError('LIMIT_FILE_SIZE', file.fieldname);
          onOverflow(error);
          callback(error);
          return;
        }
        bytes += chunk.length;
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

/** Multer drains rejected bodies before completing. An aggregate byte refusal
 * must reach the client even if it never finishes sending that body. Keep
 * Multer's cleanup running, but close this connection after the error response. */
export function receivePublishUpload(
  req: Request,
  res: Response,
  maxBytes = MAX_PUBLISH_SIZE,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let refused = false;
    const storage = publishUploadStorage(maxBytes, (error) => {
      if (refused) return;
      refused = true;
      res.setHeader('Connection', 'close');
      res.once('finish', () => req.destroy());
      reject(error);
    });
    multer({ storage, limits: publishUploadLimits }).array(
      'files',
      MAX_PUBLISH_FILES,
    )(req, res, (error) => (error ? reject(error) : resolve()));
  });
}
