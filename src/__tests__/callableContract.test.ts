// packages/providers/graphql/src/__tests__/callableContract.test.ts

/**
 * @fileoverview Contract tests for GraphQLCallableProvider (ICallableProvider)
 * @description Verifies call() wiring, error wrapping, and type contract.
 * No network calls — mocks only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ICallableProvider } from '@donotdev/core';
import { DoNotDevError } from '@donotdev/core';

import { GraphQLCallableProvider } from '../client/callableProvider';
import type { GraphQLClient } from '../client/graphqlClient';

// =============================================================================
// Mock GraphQLClient
// =============================================================================

function createMockClient(overrides?: {
  mutateResult?: Record<string, unknown>;
  mutateError?: Error;
}) {
  return {
    getToken: vi.fn().mockReturnValue('tok'),
    setToken: vi.fn(),
    query: vi.fn(),
    mutate: vi.fn().mockImplementation(() => {
      if (overrides?.mutateError) return Promise.reject(overrides.mutateError);
      return Promise.resolve(overrides?.mutateResult ?? {});
    }),
  } as unknown as GraphQLClient;
}

// =============================================================================
// Contract tests
// =============================================================================

describe('GraphQLCallableProvider — ICallableProvider contract', () => {
  let client: GraphQLClient;
  let provider: GraphQLCallableProvider;

  beforeEach(() => {
    client = createMockClient({ mutateResult: { myFunction: { ok: true } } });
    provider = new GraphQLCallableProvider(client);
  });

  // ---- Type contract ----

  it('satisfies ICallableProvider', () => {
    const typed: ICallableProvider = provider;
    expect(typed).toBeDefined();
    expect(typeof typed.call).toBe('function');
  });

  // ---- Direct function calls ----

  it('call() invokes the correct mutation with input', async () => {
    const c = createMockClient({
      mutateResult: { computeQuote: { quoteCents: 500 } },
    });
    const p = new GraphQLCallableProvider(c);
    const result = await p.call<{ projectId: string }, { quoteCents: number }>(
      'computeQuote',
      { projectId: 'p1' }
    );
    expect(c.mutate).toHaveBeenCalledWith(
      expect.stringContaining('computeQuote'),
      { input: { projectId: 'p1' } }
    );
    expect(result).toEqual({ quoteCents: 500 });
  });

  it('call() passes input data correctly', async () => {
    const c = createMockClient({
      mutateResult: { deleteAccount: null },
    });
    const p = new GraphQLCallableProvider(c);
    await p.call<{ userId: string }, void>('deleteAccount', { userId: '123' });
    expect(c.mutate).toHaveBeenCalledWith(
      expect.stringContaining('deleteAccount'),
      { input: { userId: '123' } }
    );
  });

  it('call() returns typed result on success', async () => {
    const c = createMockClient({
      mutateResult: {
        triggerJob: { jobId: 'j1', status: 'queued' },
      },
    });
    const p = new GraphQLCallableProvider(c);
    const result = await p.call<
      { projectId: string },
      { jobId: string; status: string }
    >('triggerJob', { projectId: 'p1' });
    expect(result.jobId).toBe('j1');
    expect(result.status).toBe('queued');
  });

  it('call() returns null for void functions', async () => {
    const c = createMockClient({ mutateResult: { storeWaiver: null } });
    const p = new GraphQLCallableProvider(c);
    const result = await p.call<{ projectId: string }, void>('storeWaiver', {
      projectId: 'p1',
    });
    expect(result).toBeNull();
  });

  // ---- Error handling ----

  it('throws DoNotDevError when mutate rejects with Error', async () => {
    const c = createMockClient({
      mutateError: new Error('mutation failed'),
    });
    const p = new GraphQLCallableProvider(c);
    await expect(p.call('fn', {})).rejects.toThrow(DoNotDevError);
  });

  it('throws DoNotDevError when mutate rejects with non-Error', async () => {
    const c = {
      getToken: vi.fn(),
      setToken: vi.fn(),
      query: vi.fn(),
      mutate: vi.fn().mockRejectedValue('string error'),
    } as unknown as GraphQLClient;
    const p = new GraphQLCallableProvider(c);
    await expect(p.call('fn', {})).rejects.toThrow(DoNotDevError);
  });

  it('preserves DoNotDevError when already wrapped', async () => {
    const c = {
      getToken: vi.fn(),
      setToken: vi.fn(),
      query: vi.fn(),
      mutate: vi.fn().mockRejectedValue(
        new DoNotDevError('already wrapped', {
          provider: 'test',
          operation: 'call',
        })
      ),
    } as unknown as GraphQLClient;
    const p = new GraphQLCallableProvider(c);
    await expect(p.call('fn', {})).rejects.toBeInstanceOf(DoNotDevError);
  });

  // ---- Mutation document shape ----

  it('mutation document includes the function name', async () => {
    const c = createMockClient({ mutateResult: { myMutation: 'result' } });
    const p = new GraphQLCallableProvider(c);
    await p.call('myMutation', {});
    const mockFn = c.mutate as ReturnType<typeof vi.fn>;
    const [doc] = (mockFn.mock.calls[0] ?? []) as [string, unknown];
    expect(doc).toContain('myMutation');
    expect(doc).toContain('mutation');
  });

  it('function result is extracted by function name key', async () => {
    const c = createMockClient({
      mutateResult: { sendNotification: { sent: true } },
    });
    const p = new GraphQLCallableProvider(c);
    const result = await p.call<Record<string, unknown>, { sent: boolean }>(
      'sendNotification',
      { userId: 'u1' }
    );
    expect(result.sent).toBe(true);
  });
});
