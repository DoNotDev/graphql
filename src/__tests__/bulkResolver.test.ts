// packages/providers/graphql/src/__tests__/bulkResolver.test.ts

/**
 * @fileoverview Bulk resolver: stored rows decide each patch's schema
 * @description Runs `createBulkResolver` against the real `executeBulk`: the
 * consumer's `readStored` is forwarded, so a stored draft edited without a status
 * is draft-validated, a published draft is checked whole, and a bulk with updates
 * but no `readStored` is rejected (never validated by the patch status alone).
 */

import { describe, it, expect, vi } from 'vitest';

import { createSchemas } from '@donotdev/core/server';
import type { BulkResponse } from '@donotdev/core/server';

import { createBulkResolver } from '../server/bulkResolver';
import { contactEntity } from '@dndev/test-entities';

const ENTITY = contactEntity;
/** The roles the resolver requires per bucket (a signed-in user writes contacts). */
const ACCESS = { create: 'user', read: 'user', update: 'user', delete: 'user' } as const;

const schemas = createSchemas(ENTITY);

function resolverWith(stored: Record<string, Record<string, unknown>> | null) {
  const transact = vi.fn(async (prepared: { updates: { id: string }[] }): Promise<BulkResponse> => ({
    insertedIds: [],
    updatedIds: prepared.updates.map((u) => u.id),
    deletedIds: [],
  }));
  const resolver = createBulkResolver({
    entity: ENTITY,
    createSchema: schemas.create,
    updateSchema: schemas.update,
    draftSchema: schemas.draft,
    access: ACCESS,
    transact,
    ...(stored
      ? { readStored: async (ids: readonly string[]) => new Map(ids.flatMap((id) => (stored[id] ? [[id, stored[id]!] as const] : []))) }
      : {}),
  });
  const run = (patch: Record<string, unknown>) =>
    resolver(undefined, { input: { updates: [{ id: 'c1', patch }] } }, { uid: 'u1', userRole: 'user' });
  return { run, transact };
}

describe('createBulkResolver — readStored', () => {
  it('a stored draft edited without a status is draft-validated', async () => {
    const { run } = resolverWith({ c1: { id: 'c1', name: null, status: 'draft' } });
    await expect(run({ name: null })).resolves.toMatchObject({ updatedIds: ['c1'] });
  });

  it('a published draft is checked whole against the stored row', async () => {
    const { run, transact } = resolverWith({ c1: { id: 'c1', name: null, status: 'draft' } });
    await expect(run({ status: 'available' })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(transact).not.toHaveBeenCalled();
  });

  it('a stored published row rejects clearing a required field', async () => {
    const { run } = resolverWith({ c1: { id: 'c1', name: 'Ana', status: 'available' } });
    await expect(run({ name: null })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('updates without readStored are rejected', async () => {
    const { run, transact } = resolverWith(null);
    await expect(run({ name: 'Bo' })).rejects.toMatchObject({ code: 'internal' });
    expect(transact).not.toHaveBeenCalled();
  });
});
