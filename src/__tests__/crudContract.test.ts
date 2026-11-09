// packages/providers/graphql/src/__tests__/crudContract.test.ts

/**
 * @fileoverview Contract tests for GraphQL CRUD Adapter (ICrudAdapter)
 * @description Verifies GraphQLCrudAdapter satisfies ICrudAdapter with a mocked GraphQLClient.
 * No network calls — mocks only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ICrudAdapter } from '@donotdev/core';

import { GraphQLCrudAdapter } from '../client/crudAdapter';
import type { GraphQLClient } from '../client/graphqlClient';

// =============================================================================
// Mock GraphQLClient
// =============================================================================

function createMockClient(overrides?: {
  queryResult?: Record<string, unknown>;
  mutateResult?: Record<string, unknown>;
  queryError?: Error;
  mutateError?: Error;
}) {
  return {
    getToken: vi.fn().mockReturnValue('tok'),
    setToken: vi.fn(),
    query: vi.fn().mockImplementation(() => {
      if (overrides?.queryError) return Promise.reject(overrides.queryError);
      return Promise.resolve(overrides?.queryResult ?? {});
    }),
    mutate: vi.fn().mockImplementation(() => {
      if (overrides?.mutateError) return Promise.reject(overrides.mutateError);
      return Promise.resolve(overrides?.mutateResult ?? {});
    }),
  } as unknown as GraphQLClient;
}

// =============================================================================
// Contract tests
// =============================================================================

describe('GraphQLCrudAdapter — ICrudAdapter contract', () => {
  let client: GraphQLClient;
  let adapter: GraphQLCrudAdapter;

  beforeEach(() => {
    client = createMockClient({
      queryResult: { users: null },
      mutateResult: { createUsers: { id: 'new-id' } },
    });
    adapter = new GraphQLCrudAdapter(client);
  });

  it('satisfies ICrudAdapter type', () => {
    const typed: ICrudAdapter = adapter;
    expect(typed).toBeDefined();
    expect(typeof typed.get).toBe('function');
    expect(typeof typed.add).toBe('function');
    expect(typeof typed.set).toBe('function');
    expect(typeof typed.update).toBe('function');
    expect(typeof typed.delete).toBe('function');
    expect(typeof typed.query).toBe('function');
  });

  it('serverSideOnly is false', () => {
    expect(adapter.serverSideOnly).toBe(false);
  });

  it('dbLevelSecurity is false', () => {
    expect(adapter.dbLevelSecurity).toBe(false);
  });

  // ---- get ----

  it('get() returns null when query returns null', async () => {
    const c = createMockClient({ queryResult: { users: null } });
    const ad = new GraphQLCrudAdapter(c);
    const result = await ad.get<{ id: string }>('users', 'u1');
    expect(result).toBeNull();
  });

  it('get() returns document when query returns data', async () => {
    const c = createMockClient({
      queryResult: { users: { id: 'u1', name: 'Alice' } },
    });
    const ad = new GraphQLCrudAdapter(c);
    const result = await ad.get<{ id: string; name: string }>('users', 'u1');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('u1');
    expect(result?.name).toBe('Alice');
  });

  it('get() returns null on not-found error', async () => {
    const c = createMockClient({
      queryError: new Error('Record not found'),
    });
    const ad = new GraphQLCrudAdapter(c);
    const result = await ad.get('users', 'missing');
    expect(result).toBeNull();
  });

  it('get() throws on non-not-found error', async () => {
    const c = createMockClient({
      queryError: new Error('network error'),
    });
    const ad = new GraphQLCrudAdapter(c);
    await expect(ad.get('users', 'u1')).rejects.toMatchObject({
      details: expect.objectContaining({ originalMessage: 'network error' }),
    });
  });

  it('get() throws when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.get('users', 'u1', undefined, { signal: controller.signal })
    ).rejects.toThrow('cancelled');
  });

  // ---- add ----

  it('add() returns { id, data }', async () => {
    const c = createMockClient({
      mutateResult: { createUsers: { id: 'new-id', name: 'Bob' } },
    });
    const ad = new GraphQLCrudAdapter(c);
    const result = await ad.add<{ name: string }>('users', { name: 'Bob' });
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('data');
    expect(typeof result.id).toBe('string');
    expect(result.id).toBe('new-id');
  });

  it('add() throws when mutate rejects', async () => {
    const c = createMockClient({ mutateError: new Error('insert failed') });
    const ad = new GraphQLCrudAdapter(c);
    await expect(ad.add('users', { name: 'X' })).rejects.toMatchObject({
      details: expect.objectContaining({ originalMessage: 'insert failed' }),
    });
  });

  it('add() throws when mutation returns no id', async () => {
    const c = createMockClient({
      mutateResult: { createUsers: { name: 'no id here' } },
    });
    const ad = new GraphQLCrudAdapter(c);
    await expect(ad.add('users', { name: 'X' })).rejects.toThrow();
  });

  // ---- set ----

  it('set() resolves without error', async () => {
    const c = createMockClient({
      mutateResult: { upsertUsers: { id: 'u1' } },
    });
    const ad = new GraphQLCrudAdapter(c);
    await expect(
      ad.set<{ name: string }>('users', 'u1', { name: 'Alice' })
    ).resolves.toBeUndefined();
    expect(c.mutate).toHaveBeenCalled();
  });

  it('set() throws when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.set('users', 'u1', { name: 'X' }, undefined, {
        signal: controller.signal,
      })
    ).rejects.toThrow('cancelled');
  });

  // ---- update ----

  it('update() resolves without error', async () => {
    const c = createMockClient({
      mutateResult: { updateUsers: { id: 'u1' } },
    });
    const ad = new GraphQLCrudAdapter(c);
    await expect(
      ad.update<{ name: string }>('users', 'u1', { name: 'Updated' })
    ).resolves.toBeUndefined();
    expect(c.mutate).toHaveBeenCalled();
  });

  it('update() throws when mutate rejects', async () => {
    const c = createMockClient({ mutateError: new Error('update failed') });
    const ad = new GraphQLCrudAdapter(c);
    await expect(ad.update('users', 'u1', { name: 'X' })).rejects.toMatchObject({
      details: expect.objectContaining({ originalMessage: 'update failed' }),
    });
  });

  // ---- delete ----

  it('delete() resolves without error', async () => {
    const c = createMockClient({
      mutateResult: { deleteUsers: { success: true } },
    });
    const ad = new GraphQLCrudAdapter(c);
    await expect(ad.delete('users', 'u1')).resolves.toBeUndefined();
    expect(c.mutate).toHaveBeenCalled();
  });

  it('delete() throws when mutate rejects', async () => {
    const c = createMockClient({ mutateError: new Error('delete failed') });
    const ad = new GraphQLCrudAdapter(c);
    await expect(ad.delete('users', 'u1')).rejects.toMatchObject({
      details: expect.objectContaining({ originalMessage: 'delete failed' }),
    });
  });

  // ---- query ----

  it('query() returns PaginatedQueryResult shape', async () => {
    const c = createMockClient({
      queryResult: {
        users: {
          items: [
            { id: '1', name: 'A' },
            { id: '2', name: 'B' },
          ],
          total: 2,
          hasMore: false,
          lastVisible: '2',
        },
      },
    });
    const ad = new GraphQLCrudAdapter(c);
    const result = await ad.query<{ id: string; name: string }>('users', {});
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.lastVisible).toBe('2');
  });

  it('query() returns empty result when collection returns null', async () => {
    const c = createMockClient({ queryResult: { users: null } });
    const ad = new GraphQLCrudAdapter(c);
    const result = await ad.query('users', {});
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('query() applies where filters in query args', async () => {
    const c = createMockClient({
      queryResult: { users: { items: [], total: 0, hasMore: false } },
    });
    const ad = new GraphQLCrudAdapter(c);
    await ad.query('users', {
      where: [{ field: 'status', operator: '==' as any, value: 'active' }],
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
      limit: 10,
    });
    // Just verify query was called — filter args are embedded in the query string
    expect(c.query).toHaveBeenCalled();
  });

  it('query() throws when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.query('users', {}, undefined, undefined, {
        signal: controller.signal,
      })
    ).rejects.toThrow('cancelled');
  });

  it('query() throws when query rejects', async () => {
    const c = createMockClient({ queryError: new Error('query failed') });
    const ad = new GraphQLCrudAdapter(c);
    await expect(ad.query('users', {})).rejects.toMatchObject({
      details: expect.objectContaining({ originalMessage: 'query failed' }),
    });
  });

  // ---- subscriptions not implemented ----

  it('subscribe is not defined (not supported)', () => {
    expect(adapter.subscribe).toBeUndefined();
  });

  it('subscribeToCollection is not defined (not supported)', () => {
    expect(adapter.subscribeToCollection).toBeUndefined();
  });
});
