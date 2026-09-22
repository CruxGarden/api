import { memoryStorage, StorageEngine } from 'multer';

/** Multer removes failed uploads in series. Its memory store calls back
 * synchronously, which overflows the stack when a large tool is rejected.
 * Yield between removals so the request reports an error and the API stays up. */
export function publishUploadStorage(): StorageEngine {
  const storage = memoryStorage();
  return {
    _handleFile: storage._handleFile.bind(storage),
    _removeFile(req, file, callback) {
      storage._removeFile(req, file, (error) =>
        setImmediate(() => callback(error)),
      );
    },
  };
}
