// packages/providers/graphql/src/__tests__/authContract.test.ts

/**
 * @fileoverview Contract tests for GraphQL Auth (AuthProvider)
 * @description Verifies GraphQLAuth satisfies AuthProvider with a mocked GraphQLClient.
 * No network calls — mocks only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AuthProvider } from '@donotdev/core';

import { GraphQLAuth } from '../client/auth';
import { GraphQLClient } from '../client/graphqlClient';

// =============================================================================
// Mock GraphQLClient
// =============================================================================

function createMockClient(overrides?: {
  loginPayload?: {
    token: string;
    user: { id: string; email: string; name?: string };
  };
  signupPayload?: {
    token: string;
    user: { id: string; email: string; name?: string };
  };
  meUser?: { id: string; email: string; name?: string } | null;
  token?: string | null;
  queryError?: Error;
  mutateError?: Error;
}) {
  const storedToken = overrides?.token ?? null;
  const meUser = overrides?.meUser ?? null;

  const client = {
    getToken: vi.fn().mockReturnValue(storedToken),
    setToken: vi.fn(),
    query: vi.fn().mockImplementation(() => {
      if (overrides?.queryError) return Promise.reject(overrides.queryError);
      return Promise.resolve({ me: meUser });
    }),
    mutate: vi.fn().mockImplementation((doc: string) => {
      if (overrides?.mutateError) return Promise.reject(overrides.mutateError);
      if (doc.includes('login') && overrides?.loginPayload) {
        return Promise.resolve({ login: overrides.loginPayload });
      }
      if (doc.includes('signup') && overrides?.signupPayload) {
        return Promise.resolve({ signup: overrides.signupPayload });
      }
      return Promise.reject(new Error('mock mutate'));
    }),
  } as unknown as GraphQLClient;

  return client;
}

// =============================================================================
// Contract tests
// =============================================================================

describe('GraphQLAuth — AuthProvider contract', () => {
  let client: GraphQLClient;
  let provider: GraphQLAuth;

  beforeEach(() => {
    client = createMockClient();
    provider = new GraphQLAuth(client);
  });

  it('satisfies AuthProvider type', () => {
    const typed: AuthProvider = provider;
    expect(typed).toBeDefined();
  });

  it('has required AuthProvider methods', () => {
    expect(typeof provider.initialize).toBe('function');
    expect(typeof provider.getCurrentUser).toBe('function');
    expect(typeof provider.signInWithEmailAndPassword).toBe('function');
    expect(typeof provider.createUserWithEmailAndPassword).toBe('function');
    expect(typeof provider.signOut).toBe('function');
    expect(typeof provider.onAuthStateChanged).toBe('function');
    expect(typeof provider.getAccessToken).toBe('function');
    expect(typeof provider.hasRole).toBe('function');
    expect(typeof provider.hasFeature).toBe('function');
    expect(typeof provider.hasTier).toBe('function');
  });

  it('initialize() resolves without throwing when no token', async () => {
    await expect(provider.initialize()).resolves.toBeUndefined();
    // No token — should not call query
    expect(client.query).not.toHaveBeenCalled();
  });

  it('initialize() calls me query when token exists', async () => {
    const clientWithToken = createMockClient({
      token: 'existing-token',
      meUser: { id: 'u1', email: 'test@example.com' },
    });
    const p = new GraphQLAuth(clientWithToken);
    await p.initialize();
    expect(clientWithToken.query).toHaveBeenCalledWith(
      expect.stringContaining('me'),
      undefined
    );
  });

  it('initialize() clears token when me returns null', async () => {
    const clientWithToken = createMockClient({
      token: 'bad-token',
      meUser: null,
    });
    const p = new GraphQLAuth(clientWithToken);
    await p.initialize();
    expect(clientWithToken.setToken).toHaveBeenCalledWith(null);
  });

  it('getCurrentUser() returns null when no token', async () => {
    const user = await provider.getCurrentUser();
    expect(user).toBeNull();
  });

  it('getCurrentUser() returns AuthUser when me returns user', async () => {
    const c = createMockClient({
      token: 'tok',
      meUser: { id: 'u1', email: 'a@b.com', name: 'Alice' },
    });
    const p = new GraphQLAuth(c);
    const user = await p.getCurrentUser();
    expect(user).not.toBeNull();
    expect(user?.id).toBe('u1');
    expect(user?.email).toBe('a@b.com');
    expect(user?.displayName).toBe('Alice');
  });

  it('signInWithEmailAndPassword() stores token and returns AuthUser', async () => {
    const c = createMockClient({
      loginPayload: {
        token: 'jwt-token',
        user: { id: 'u1', email: 'login@example.com' },
      },
    });
    const p = new GraphQLAuth(c);
    const user = await p.signInWithEmailAndPassword(
      'login@example.com',
      'pass'
    );
    expect(user.id).toBe('u1');
    expect(user.email).toBe('login@example.com');
    expect(c.setToken).toHaveBeenCalledWith('jwt-token');
  });

  it('signInWithEmailAndPassword() throws when mutate rejects', async () => {
    const c = createMockClient({ mutateError: new Error('bad credentials') });
    const p = new GraphQLAuth(c);
    await expect(
      p.signInWithEmailAndPassword('a@b.com', 'wrong')
    ).rejects.toThrow();
  });

  it('createUserWithEmailAndPassword() stores token and returns AuthUser', async () => {
    const c = createMockClient({
      signupPayload: {
        token: 'signup-token',
        user: { id: 'u2', email: 'new@example.com' },
      },
    });
    const p = new GraphQLAuth(c);
    const user = await p.createUserWithEmailAndPassword(
      'new@example.com',
      'pass',
      { householdName: 'Smith', name: 'Bob' } as any
    );
    expect(user.id).toBe('u2');
    expect(c.setToken).toHaveBeenCalledWith('signup-token');
  });

  it('signOut() clears token and notifies listeners', async () => {
    // First sign in
    const c = createMockClient({
      loginPayload: { token: 'tok', user: { id: 'u1', email: 'a@b.com' } },
    });
    const p = new GraphQLAuth(c);
    await p.signInWithEmailAndPassword('a@b.com', 'pass');

    const cb = vi.fn();
    p.onAuthStateChanged(cb);
    cb.mockClear();

    await p.signOut();
    expect(c.setToken).toHaveBeenCalledWith(null);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it('onAuthStateChanged() returns unsubscribe function', () => {
    const unsub = provider.onAuthStateChanged(vi.fn());
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('onAuthStateChanged() fires immediately with current user', () => {
    const cb = vi.fn();
    provider.onAuthStateChanged(cb);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it('getAccessToken() returns stored token', async () => {
    const c = createMockClient({ token: 'my-token' });
    const p = new GraphQLAuth(c);
    const token = await p.getAccessToken();
    expect(token).toBe('my-token');
  });

  it('getAccessToken() returns null when no token', async () => {
    const token = await provider.getAccessToken();
    expect(token).toBeNull();
  });

  it('hasRole() returns false when no user', async () => {
    expect(await provider.hasRole('admin')).toBe(false);
  });

  it('hasFeature() returns false when no user', async () => {
    expect(await provider.hasFeature('export')).toBe(false);
  });

  it('hasTier() returns false when no user', async () => {
    expect(await provider.hasTier('pro')).toBe(false);
  });

  it('signInWithPartner() throws with descriptive message', async () => {
    await expect(provider.signInWithPartner('google' as any)).rejects.toThrow(
      'GraphQL provider does not support OAuth'
    );
  });

  it('linkWithPartner() throws with descriptive message', async () => {
    await expect(provider.linkWithPartner('github' as any)).rejects.toThrow(
      'GraphQL provider'
    );
  });

  it('sendPasswordResetEmail() throws', async () => {
    await expect(provider.sendPasswordResetEmail('a@b.com')).rejects.toThrow();
  });

  it('isSignInWithEmailLink() always returns false', () => {
    expect(provider.isSignInWithEmailLink('http://example.com?token=abc')).toBe(
      false
    );
  });

  it('refreshToken() returns existing token', async () => {
    const c = createMockClient({ token: 'existing' });
    const p = new GraphQLAuth(c);
    const token = await p.refreshToken();
    expect(token).toBe('existing');
  });
});
