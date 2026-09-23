import {
  realpathSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  linkSync,
} from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { inspectDesktopRecovery } from './desktop-recovery';
import * as sqliteGraph from '../common/database/sqlite-graph';
import { DbService } from '../common/services/db.service';

const Database = require('better-sqlite3');
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('API-owned database replacement', () => {
  let scratch: string;
  let filename: string;
  let owner: LocalGraphRuntime;
  let incoming: ArrayBuffer;
  let recoveryRequired = false;
  beforeEach(async () => {
    recoveryRequired = false;
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'crux-api-replace-')));
    filename = join(scratch, 'current.db');
    owner = await LocalGraphRuntime.create(filename);
    await owner.run("INSERT INTO settings VALUES ('version', 'original')");
    const candidate = await LocalGraphRuntime.create(
      join(scratch, 'incoming.db'),
    );
    await candidate.run("INSERT INTO settings VALUES ('version', 'incoming')");
    incoming = await candidate.closeWithRecoveryImage();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (recoveryRequired)
      await expect(owner.close()).rejects.toThrow('recovery required');
    else await owner.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const version = (runtime: LocalGraphRuntime) =>
    runtime.get("SELECT value FROM settings WHERE key = 'version'");

  it('captures admitted writes for rollback, excludes later commands, and captures incoming bytes at admission', async () => {
    const entered = signal();
    const release = signal();
    const work = owner.execute(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const write = owner.run("INSERT INTO settings VALUES ('last', 'accepted')");
    const replacement = owner.replaceDatabase(incoming);
    new Uint8Array(incoming).fill(0);
    try {
      await expect(owner.run('DELETE FROM settings')).rejects.toThrow(
        'replacing',
      );
      await expect(owner.replaceDatabase(new ArrayBuffer(0))).rejects.toThrow(
        'replacing',
      );
      await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
        'already owned',
      );
    } finally {
      release.resolve();
    }
    await Promise.all([work, write]);
    const previous = await replacement;
    expect(await version(owner)).toEqual({ value: 'incoming' });
    const backup = new Database(
      Buffer.from(inspectDesktopRecovery(previous).database),
    );
    try {
      expect(
        backup.prepare("SELECT value FROM settings WHERE key = 'last'").get(),
      ).toEqual({ value: 'accepted' });
    } finally {
      backup.close();
    }
    // The new file identity is owned, too.
    const alias = join(scratch, 'alias.db');
    linkSync(filename, alias);
    await expect(LocalGraphRuntime.open(alias)).rejects.toThrow(
      'already owned',
    );
    await owner.close();
    owner = await LocalGraphRuntime.open(filename);
    expect(await version(owner)).toEqual({ value: 'incoming' });
    await owner.replaceDatabase(previous);
    expect(await version(owner)).toEqual({ value: 'original' });
    expect(
      await owner.get("SELECT value FROM settings WHERE key = 'last'"),
    ).toEqual({ value: 'accepted' });
  });

  it('keeps ownership of the new inode while its API context is still starting', async () => {
    const entered = signal();
    const release = signal();
    const prepare = sqliteGraph.prepareDesktopGraph;
    jest
      .spyOn(sqliteGraph, 'prepareDesktopGraph')
      .mockImplementation(async (db) => {
        if (db.client.config.connection.filename === filename) {
          entered.resolve();
          await release.promise;
        }
        return prepare(db);
      });
    const replacing = owner.replaceDatabase(incoming);
    await entered.promise;
    try {
      const alias = join(scratch, 'reopening-alias.db');
      linkSync(filename, alias);
      await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
        'already owned',
      );
      await expect(LocalGraphRuntime.open(alias)).rejects.toThrow(
        'already owned',
      );
      await expect(owner.get('SELECT * FROM settings')).rejects.toThrow(
        'replacing',
      );
      await expect(owner.closeWithRecoveryImage()).rejects.toThrow('replacing');
    } finally {
      release.resolve();
    }
    await replacing;
    expect(await version(owner)).toEqual({ value: 'incoming' });
  });

  it('retains recovery bytes and refuses all owners when automatic rollback also fails', async () => {
    const prepare = sqliteGraph.prepareDesktopGraph;
    jest
      .spyOn(sqliteGraph, 'prepareDesktopGraph')
      .mockImplementation(async (db) => {
        if (db.client.config.connection.filename === filename)
          throw new Error('Injected startup failure');
        return prepare(db);
      });
    const rename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('.recovery'))
        throw new Error('Injected rollback failure');
      return rename(from, to);
    });
    recoveryRequired = true;
    await expect(owner.replaceDatabase(incoming)).rejects.toThrow(
      'recovery required',
    );
    jest.restoreAllMocks();
    await expect(owner.get('SELECT * FROM settings')).rejects.toThrow(
      'recovery required',
    );
    await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
      'already owned',
    );
    const retained = readdirSync(scratch).find((name) =>
      name.endsWith('.recovery'),
    );
    expect(retained).toBeTruthy();
    const bytes = readFileSync(join(scratch, retained));
    const backup = new Database(bytes);
    try {
      expect(
        backup
          .prepare("SELECT value FROM settings WHERE key = 'version'")
          .get(),
      ).toEqual({ value: 'original' });
    } finally {
      backup.close();
    }
  });

  it('fails closed if the previous owner cannot confirm shutdown', async () => {
    const destroy = DbService.prototype.onModuleDestroy;
    jest
      .spyOn(DbService.prototype, 'onModuleDestroy')
      .mockImplementation(async function (this: DbService) {
        const current =
          this.query().client.config.connection.filename === filename;
        await destroy.call(this);
        if (current) throw new Error('Injected uncertain shutdown');
      });
    recoveryRequired = true;
    await expect(owner.replaceDatabase(incoming)).rejects.toThrow(
      'recovery required',
    );
    jest.restoreAllMocks();
    await expect(owner.replaceDatabase(incoming)).rejects.toThrow(
      'recovery required',
    );
    await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
      'already owned',
    );
    expect(
      readdirSync(scratch).filter(
        (file) => file.endsWith('.restore') || file.endsWith('.recovery'),
      ),
    ).toHaveLength(2);
    const original = new Database(filename, { readonly: true });
    try {
      expect(
        original
          .prepare("SELECT value FROM settings WHERE key = 'version'")
          .get(),
      ).toEqual({ value: 'original' });
    } finally {
      original.close();
    }
  });

  it('refuses invalid input without disturbing the owner', async () => {
    await expect(owner.replaceDatabase(new ArrayBuffer(0))).rejects.toThrow(
      'header',
    );
    expect(await version(owner)).toEqual({ value: 'original' });
    await owner.replaceDatabase(incoming);
    expect(await version(owner)).toEqual({ value: 'incoming' });
  });

  it.each(['write', 'safety image', 'rename', 'reopen'])(
    'preserves the previous database and allows retry after a %s failure',
    async (fault) => {
      const write = fs.writeFileSync;
      const rename = fs.renameSync;
      const serialize = Database.prototype.serialize;
      const pragma = Database.prototype.pragma;
      if (fault === 'write') {
        jest
          .spyOn(fs, 'writeFileSync')
          .mockImplementation((file, data, options) => {
            write(
              file,
              Buffer.from(data as Uint8Array).subarray(0, 7),
              options,
            );
            throw new Error('Injected partial write');
          });
      } else if (fault === 'safety image') {
        jest
          .spyOn(Database.prototype, 'serialize')
          .mockImplementation(function (this: { name: string }) {
            if (this.name === filename)
              throw new Error('Injected safety image failure');
            return serialize.call(this);
          });
      } else if (fault === 'rename') {
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
          if (to === filename) throw new Error('Injected rename failure');
          return rename(from, to);
        });
      } else {
        let fail = true;
        jest.spyOn(Database.prototype, 'pragma').mockImplementation(function (
          this: { name: string },
          sql: unknown,
          ...args: unknown[]
        ) {
          if (fail && this.name === filename && sql === 'foreign_keys = ON') {
            fail = false;
            throw new Error('Injected reopen failure');
          }
          return pragma.call(this, sql, ...args);
        });
      }
      await expect(owner.replaceDatabase(incoming)).rejects.toThrow('Injected');
      jest.restoreAllMocks();
      expect(await version(owner)).toEqual({ value: 'original' });
      await expect(LocalGraphRuntime.open(filename)).rejects.toThrow(
        'already owned',
      );
      await owner.close();
      owner = await LocalGraphRuntime.open(filename);
      expect(await version(owner)).toEqual({ value: 'original' });
      await owner.replaceDatabase(incoming);
      expect(await version(owner)).toEqual({ value: 'incoming' });
      await owner.close();
      expect(readdirSync(scratch).sort()).toEqual([
        'current.db',
        'incoming.db',
      ]);
      expect(readFileSync(filename).length).toBeGreaterThan(100);
    },
  );

  it('shutdown waits for replacement, then releases the resulting owner', async () => {
    const replace = owner.replaceDatabase(incoming);
    const close = owner.close();
    await expect(owner.exportDatabase()).rejects.toThrow('closing');
    await Promise.all([replace, close]);
    owner = await LocalGraphRuntime.open(filename);
    expect(await version(owner)).toEqual({ value: 'incoming' });
  });

  it('refuses replacement within a graph command and after close', async () => {
    await expect(
      owner.execute(() => owner.replaceDatabase(incoming)),
    ).rejects.toThrow('Nested');
    expect(await version(owner)).toEqual({ value: 'original' });
    await owner.close();
    await expect(owner.replaceDatabase(incoming)).rejects.toThrow('closing');
  });
});
