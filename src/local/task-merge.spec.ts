import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('owned Task merge finalization', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let main: string,
    copy: string,
    candidate: string,
    merge: string,
    result: string;
  const state = async () => ({
    copies: await owner.all('SELECT * FROM working_copies ORDER BY id'),
    merge: await owner.get<any>('SELECT * FROM task_merges WHERE id = ?', [
      merge,
    ]),
  });
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-merge-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    const identity = { authorId: randomUUID(), homeId: randomUUID() };
    main = await owner.createCrux({ ...identity, slug: 'main' });
    copy = randomUUID();
    candidate = randomUUID();
    merge = randomUUID();
    result = await owner.createCrux({
      ...identity,
      slug: 'result',
      kind: 'snapshot',
      meta: { contentOwnerId: main, merge: { id: merge, copyId: copy } },
    });
    await owner.execute(({ dimension }) =>
      dimension.create({
        ...identity,
        sourceId: main,
        targetId: result,
        type: 'growth' as any,
      }),
    );
    for (const [id, role] of [
      [copy, 'task'],
      [candidate, 'review'],
    ]) {
      await owner.run(
        'INSERT INTO working_copies (id, crux_id, task_id, title, base_snapshot_id, role, phase, meta, revision, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          main,
          randomUUID(),
          role,
          randomUUID(),
          role,
          'ready',
          JSON.stringify({ preserved: 'state' }),
          2,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
    }
    await owner.run(
      'INSERT INTO task_merges (id, crux_id, copy_id, candidate_id, phase, data, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        merge,
        main,
        copy,
        candidate,
        'applying',
        JSON.stringify({
          id: merge,
          cruxId: main,
          copyId: copy,
          candidateId: candidate,
          phase: 'applying',
          manifest: {},
          resolutions: { 'one.txt': 'task' },
          verificationLog: 'Preserve this evidence',
        }),
        new Date().toISOString(),
      ],
    );
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function makeReview() {
    const current = await state();
    const data = {
      ...JSON.parse(current.merge.data),
      phase: 'review',
      previewUrl: 'http://localhost:12345',
    };
    await owner.run(
      "UPDATE task_merges SET phase = 'review', data = ? WHERE id = ?",
      [JSON.stringify(data), merge],
    );
  }
  it('cancels a review atomically without changing the source Task and safely repeats after restart', async () => {
    await makeReview();
    const source = await owner.get(
      'SELECT * FROM working_copies WHERE id = ?',
      [copy],
    );
    await owner.releaseTaskReview(merge);
    const saved = await state();
    expect(
      await owner.get('SELECT * FROM working_copies WHERE id = ?', [copy]),
    ).toEqual(source);
    expect(saved.copies).toContainEqual(
      expect.objectContaining({
        id: candidate,
        phase: 'archived',
        revision: 3,
      }),
    );
    expect(saved.merge.phase).toBe('cancelled');
    expect(JSON.parse(saved.merge.data)).not.toHaveProperty('previewUrl');
    expect(JSON.parse(saved.merge.data)).toMatchObject({
      verificationLog: 'Preserve this evidence',
      resolutions: { 'one.txt': 'task' },
    });
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    await owner.releaseTaskReview(merge);
    expect(await state()).toEqual(saved);
  });
  it.each(['ABORT', 'IGNORE'])(
    'rolls back candidate archival when cancellation is %s',
    async (mode) => {
      await makeReview();
      const before = await state();
      await owner.run(
        `CREATE TRIGGER refuse_cancel BEFORE UPDATE ON task_merges BEGIN SELECT RAISE(${mode}${mode === 'ABORT' ? ", 'Cancel refused'" : ''}); END`,
      );
      await expect(owner.releaseTaskReview(merge)).rejects.toThrow();
      expect(await state()).toEqual(before);
      await owner.run('DROP TRIGGER refuse_cancel');
      await owner.releaseTaskReview(merge);
      expect((await state()).merge.phase).toBe('cancelled');
    },
  );
  it('refuses to cancel an applying merge and preserves a completed result when closing again', async () => {
    const before = await state();
    await expect(owner.releaseTaskReview(merge)).rejects.toThrow('recover');
    expect(await state()).toEqual(before);
    await owner.completeTaskMerge(merge, result);
    const completed = await state();
    await owner.releaseTaskReview(merge);
    expect(await state()).toEqual(completed);
  });
  it('finishes cancellation of an already archived candidate without touching its revision', async () => {
    await makeReview();
    await owner.run(
      "UPDATE working_copies SET phase = 'archived', revision = 3 WHERE id = ?",
      [candidate],
    );
    await owner.releaseTaskReview(merge);
    expect((await state()).copies).toContainEqual(
      expect.objectContaining({
        id: candidate,
        phase: 'archived',
        revision: 3,
      }),
    );
  });
  it('commits Task, candidate and journal together, preserves evidence and is retryable after restart', async () => {
    const notices: unknown[] = [];
    owner.onChange((change) => {
      notices.push(change);
    });
    await owner.completeTaskMerge(merge, result);
    let saved = await state();
    expect(saved.copies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: copy, phase: 'merged', revision: 3 }),
        expect.objectContaining({
          id: candidate,
          phase: 'archived',
          revision: 3,
        }),
      ]),
    );
    expect(saved.merge.phase).toBe('merged');
    expect(JSON.parse(saved.merge.data)).toMatchObject({
      resultHead: result,
      phase: 'merged',
      resolutions: { 'one.txt': 'task' },
      verificationLog: 'Preserve this evidence',
    });
    expect(notices).toMatchObject([
      { entity: 'working-copy', id: copy, cruxId: main, fields: ['phase'] },
    ]);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    await owner.completeTaskMerge(merge, result);
    expect(await state()).toEqual(saved);
  });
  it.each(['ABORT', 'IGNORE'])(
    'rolls back both copies when the final journal write is %s, then resumes',
    async (mode) => {
      const before = await state();
      await owner.run(
        `CREATE TRIGGER refuse_finish BEFORE UPDATE ON task_merges BEGIN SELECT RAISE(${mode}${mode === 'ABORT' ? ", 'Journal refused'" : ''}); END`,
      );
      await expect(owner.completeTaskMerge(merge, result)).rejects.toThrow();
      expect(await state()).toEqual(before);
      await owner.run('DROP TRIGGER refuse_finish');
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      await owner.completeTaskMerge(merge, result);
      expect((await state()).merge.phase).toBe('merged');
    },
  );
  it('rolls back when a journal trigger reverses an earlier Task transition', async () => {
    await owner.run(
      `CREATE TRIGGER reverse_task AFTER UPDATE ON task_merges BEGIN UPDATE working_copies SET phase = 'ready' WHERE id = '${copy}'; END`,
    );
    const before = await state();
    await expect(owner.completeTaskMerge(merge, result)).rejects.toThrow(
      'persist',
    );
    expect(await state()).toEqual(before);
  });
  it('repairs an older partially completed Task without duplicating its revision', async () => {
    await owner.run(
      "UPDATE working_copies SET phase = 'merged', revision = 3 WHERE id = ?",
      [copy],
    );
    await owner.completeTaskMerge(merge, result);
    expect((await state()).copies).toContainEqual(
      expect.objectContaining({ id: copy, phase: 'merged', revision: 3 }),
    );
  });
  it('refuses result snapshots from a different merge without changing state', async () => {
    const before = await state();
    await owner.updateCrux(result, { meta: { merge: { id: randomUUID() } } });
    await expect(owner.completeTaskMerge(merge, result)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it('refuses a result without its owning Growth edge', async () => {
    await owner.run('DELETE FROM dimensions WHERE target_id = ?', [result]);
    const before = await state();
    await expect(owner.completeTaskMerge(merge, result)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it('protects applying Tasks from archive and rejects mismatched journal identities', async () => {
    await expect(owner.setWorkingCopyArchived(copy, true, 2)).rejects.toThrow();
    const before = await state();
    const data = JSON.parse(before.merge.data);
    data.copyId = candidate;
    await owner.run('UPDATE task_merges SET data = ? WHERE id = ?', [
      JSON.stringify(data),
      merge,
    ]);
    await expect(owner.completeTaskMerge(merge, result)).rejects.toThrow();
    expect((await state()).copies).toEqual(before.copies);
  });
  it('retains ownership when a candidate belongs to another Crux', async () => {
    await owner.run('UPDATE working_copies SET crux_id = ? WHERE id = ?', [
      randomUUID(),
      candidate,
    ]);
    const before = await state();
    await expect(owner.completeTaskMerge(merge, result)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
});
