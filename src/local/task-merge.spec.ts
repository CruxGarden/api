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
  async function verifiedReview() {
    await makeReview();
    const identity = { authorId: randomUUID(), homeId: randomUUID() };
    const heads: string[] = [];
    for (const id of [main, copy]) {
      const snapshot = await owner.createCrux({
        ...identity,
        slug: randomUUID(),
        kind: 'snapshot',
        meta: { contentOwnerId: id },
      });
      await owner.execute(({ dimension }) =>
        dimension.create({
          ...identity,
          sourceId: id,
          targetId: snapshot,
          type: 'growth' as any,
          weight: 1,
        }),
      );
      heads.push(snapshot);
    }
    const data = {
      ...JSON.parse((await state()).merge.data),
      targetHead: heads[0],
      sourceHead: heads[1],
      base: {},
      main: {},
      task: {},
      manifest: {},
      conflicts: [],
      verifiedKey: '[]',
    };
    await owner.run('UPDATE task_merges SET data = ? WHERE id = ?', [
      JSON.stringify(data),
      merge,
    ]);
    return data;
  }
  it('creates a review without changing its copies and safely repeats after restart', async () => {
    const review = {
      ...(await verifiedReview()),
      extension: { preserved: ['opaque', 1] },
    };
    await owner.run('DELETE FROM task_merges WHERE id = ?', [merge]);
    const before = await state();
    await owner.saveTaskReview(JSON.stringify(review));
    const saved = await state();
    expect(saved.copies).toEqual(before.copies);
    expect(JSON.parse(saved.merge.data)).toEqual(review);
    expect(saved.merge.phase).toBe('review');
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    await owner.saveTaskReview(JSON.stringify(review));
    expect(await state()).toEqual(saved);
  });
  it('allows a verified update only against the exact previous review and retains extension data', async () => {
    const original = {
      ...(await verifiedReview()),
      extension: { retained: true },
    };
    await owner.run('UPDATE task_merges SET data = ? WHERE id = ?', [
      JSON.stringify(original),
      merge,
    ]);
    const next = {
      ...original,
      verificationLog: 'Rechecked preview',
      previewUrl: 'http://localhost:23456',
    };
    await owner.saveTaskReview(JSON.stringify(next), JSON.stringify(original));
    expect(JSON.parse((await state()).merge.data)).toEqual(next);
    const saved = await state();
    await expect(
      owner.saveTaskReview(
        JSON.stringify({ ...original, verificationLog: 'Late check' }),
        JSON.stringify(original),
      ),
    ).rejects.toThrow();
    expect(await state()).toEqual(saved);
  });
  it.each(['cancelled', 'applying', 'merged'])(
    'never resurrects a %s journal with a late verification',
    async (phase) => {
      const review = await verifiedReview();
      await owner.run(
        'UPDATE task_merges SET phase = ?, data = ? WHERE id = ?',
        [phase, JSON.stringify({ ...review, phase }), merge],
      );
      const before = await state();
      await expect(
        owner.saveTaskReview(
          JSON.stringify({ ...review, verificationLog: 'Late build' }),
          JSON.stringify(review),
        ),
      ).rejects.toThrow();
      expect(await state()).toEqual(before);
    },
  );
  it.each(['candidateId', 'sourceHead', 'main'])(
    'refuses rewriting the fixed %s reference of a review',
    async (field) => {
      const review = await verifiedReview();
      const before = await state();
      const changed = {
        ...review,
        [field]: field === 'main' ? { 'other.txt': {} } : randomUUID(),
      };
      await expect(
        owner.saveTaskReview(JSON.stringify(changed), JSON.stringify(review)),
      ).rejects.toThrow();
      expect(await state()).toEqual(before);
    },
  );
  it('refuses using another review’s candidate or a missing expected review', async () => {
    const review = await verifiedReview();
    const second = { ...review, id: randomUUID() };
    const before = await state();
    await expect(
      owner.saveTaskReview(JSON.stringify(second)),
    ).rejects.toThrow();
    await expect(
      owner.saveTaskReview(JSON.stringify(second), JSON.stringify(second)),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it.each(['insert', 'update'])(
    'rolls back an ignored review %s and retries without dropping evidence',
    async (operation) => {
      const review = await verifiedReview();
      if (operation === 'insert')
        await owner.run('DELETE FROM task_merges WHERE id = ?', [merge]);
      await owner.run(
        `CREATE TRIGGER ignore_review BEFORE ${operation.toUpperCase()} ON task_merges BEGIN SELECT RAISE(IGNORE); END`,
      );
      const before = await state();
      const next = { ...review, verificationLog: 'New evidence' };
      const expected =
        operation === 'update' ? JSON.stringify(review) : undefined;
      await expect(
        owner.saveTaskReview(JSON.stringify(next), expected),
      ).rejects.toThrow();
      expect(await state()).toEqual(before);
      await owner.run('DROP TRIGGER ignore_review');
      await owner.saveTaskReview(JSON.stringify(next), expected);
      expect(JSON.parse((await state()).merge.data)).toEqual(next);
    },
  );
  it('admits the checked review durably before file projection without changing Task state', async () => {
    const review = await verifiedReview();
    const before = await state();
    await owner.beginTaskMerge(merge, JSON.stringify(review));
    const saved = await state();
    expect(saved.copies).toEqual(before.copies);
    expect(saved.merge.phase).toBe('applying');
    expect(JSON.parse(saved.merge.data)).toEqual({
      ...review,
      phase: 'applying',
    });
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await state()).toEqual(saved);
    await expect(owner.releaseTaskReview(merge)).rejects.toThrow('recover');
    await expect(
      owner.beginTaskMerge(merge, JSON.stringify(review)),
    ).rejects.toThrow();
  });
  it('admits only one competing review for Main', async () => {
    const review = await verifiedReview();
    const second = { ...review, id: randomUUID() };
    await owner.run(
      'INSERT INTO task_merges SELECT ?, crux_id, copy_id, candidate_id, phase, ?, created FROM task_merges WHERE id = ?',
      [second.id, JSON.stringify(second), merge],
    );
    const attempts = await Promise.allSettled([
      owner.beginTaskMerge(merge, JSON.stringify(review)),
      owner.beginTaskMerge(second.id, JSON.stringify(second)),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await owner.all("SELECT id FROM task_merges WHERE phase = 'applying'"),
    ).toHaveLength(1);
    expect(
      await owner.all("SELECT id FROM task_merges WHERE phase = 'review'"),
    ).toHaveLength(1);
  });
  it('refuses a stale review even if the later review is also verified', async () => {
    const review = await verifiedReview();
    await owner.run('UPDATE task_merges SET data = ? WHERE id = ?', [
      JSON.stringify({ ...review, verificationLog: 'New check' }),
      merge,
    ]);
    const before = await state();
    await expect(
      owner.beginTaskMerge(merge, JSON.stringify(review)),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it.each([
    'conflicts',
    'unchecked',
    'archived-source',
    'archived-candidate',
    'changed-head',
    'deleted-head',
  ])('refuses %s before changing the journal', async (fault) => {
    const review = await verifiedReview();
    if (fault === 'conflicts') review.conflicts = ['unresolved'];
    if (fault === 'unchecked') review.verifiedKey = 'stale';
    if (fault === 'archived-source' || fault === 'archived-candidate')
      await owner.run(
        "UPDATE working_copies SET phase = 'archived' WHERE id = ?",
        [fault === 'archived-source' ? copy : candidate],
      );
    if (fault === 'changed-head')
      await owner.updateCrux(main, {
        meta: { settings: { activeBranch: result } },
      });
    if (fault === 'deleted-head')
      await owner.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
        new Date().toISOString(),
        review.sourceHead,
      ]);
    await owner.run('UPDATE task_merges SET data = ? WHERE id = ?', [
      JSON.stringify(review),
      merge,
    ]);
    const before = await state();
    await expect(
      owner.beginTaskMerge(merge, JSON.stringify(review)),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it.each(['ABORT', 'IGNORE'])(
    'rolls back an admission trigger %s and permits a clean retry',
    async (action) => {
      const review = await verifiedReview();
      await owner.run(
        `CREATE TRIGGER refuse_admission BEFORE UPDATE ON task_merges WHEN NEW.phase = 'applying' BEGIN SELECT RAISE(${action}${action === 'ABORT' ? ", 'Admission refused'" : ''}); END`,
      );
      const before = await state();
      await expect(
        owner.beginTaskMerge(merge, JSON.stringify(review)),
      ).rejects.toThrow();
      expect(await state()).toEqual(before);
      await owner.run('DROP TRIGGER refuse_admission');
      await owner.beginTaskMerge(merge, JSON.stringify(review));
      expect((await state()).merge.phase).toBe('applying');
    },
  );
  it('rolls back a trigger that closes the candidate during admission', async () => {
    const review = await verifiedReview();
    await owner.run(
      `CREATE TRIGGER close_candidate AFTER UPDATE ON task_merges WHEN NEW.phase = 'applying' BEGIN UPDATE working_copies SET phase = 'archived' WHERE id = NEW.candidate_id; END`,
    );
    const before = await state();
    await expect(
      owner.beginTaskMerge(merge, JSON.stringify(review)),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it('closes the legacy imported cancelled-column/review-data state without losing evidence', async () => {
    await makeReview();
    await owner.run("UPDATE task_merges SET phase = 'cancelled' WHERE id = ?", [
      merge,
    ]);
    await owner.releaseTaskReview(merge);
    const saved = await state();
    expect(saved.merge.phase).toBe('cancelled');
    expect(JSON.parse(saved.merge.data)).toMatchObject({
      phase: 'cancelled',
      verificationLog: 'Preserve this evidence',
      resolutions: { 'one.txt': 'task' },
    });
    expect(JSON.parse(saved.merge.data)).not.toHaveProperty('previewUrl');
    expect(saved.copies).toContainEqual(
      expect.objectContaining({
        id: candidate,
        phase: 'archived',
        revision: 3,
      }),
    );
    await owner.releaseTaskReview(merge);
    expect(await state()).toEqual(saved);
  });
  it('does not treat an applying-data/cancelled-column mismatch as a cancellable imported review', async () => {
    await owner.run("UPDATE task_merges SET phase = 'cancelled' WHERE id = ?", [
      merge,
    ]);
    const before = await state();
    await expect(owner.releaseTaskReview(merge)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
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
