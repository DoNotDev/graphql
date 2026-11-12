// packages/providers/graphql/src/client/graphqlClient.ts

/**
 * @fileoverview GraphQL Client
 * @description Minimal fetch-based GraphQL client. No Apollo, no urql — pure fetch.
 * Stores JWT token and injects Authorization header when set.
 *
 * @version 0.0.1
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

const TOKEN_STORAGE_KEY = 'dndev.graphql.token';

// =============================================================================
// GraphQLClient
// =============================================================================

/**
 * Minimal GraphQL client backed by fetch.
 * Token is persisted in localStorage (client-only).
 *
 * @version 0.0.1
 * @since 0.0.1
 */
export class GraphQLClient {
  private token: string | null = null;

  constructor(private readonly endpoint: string) {
    // Restore token from localStorage on construction (CSR-safe guard)
    if (typeof localStorage !== 'undefined') {
      this.token = localStorage.getItem(TOKEN_STORAGE_KEY);
    }
  }

  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------

  /**
   * Set the bearer token. Persists to localStorage and includes it in all
   * subsequent requests as `Authorization: Bearer <token>`.
   * Pass `null` to clear.
   */
  setToken(token: string | null): void {
    this.token = token;
    if (typeof localStorage !== 'undefined') {
      if (token === null) {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      } else {
        localStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
    }
  }

  /**
   * Return the currently stored token, or `null` if none.
   */
  getToken(): string | null {
    return this.token;
  }

  // ---------------------------------------------------------------------------
  // Internal request
  // ---------------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  private async request<T>(
    document: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const body: Record<string, unknown> = { query: document };
    if (variables !== undefined) {
      body['variables'] = variables;
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `GraphQL request failed: HTTP ${response.status} ${response.statusText}`
      );
    }

    // why: `T` is the caller's operation result type; the GraphQL response has no schema here
    const json = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      const message = json.errors[0]?.message ?? 'Unknown GraphQL error';
      throw new Error(`GraphQL error: ${message}`);
    }

    if (json.data === undefined) {
      throw new Error('GraphQL response missing data field');
    }

    return json.data;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Execute a GraphQL query.
   *
   * @param query - GraphQL query document string
   * @param variables - Optional query variables
   * @returns Typed response data
   */
  async query<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    return this.request<T>(query, variables);
  }

  /**
   * Execute a GraphQL mutation.
   *
   * @param mutation - GraphQL mutation document string
   * @param variables - Optional mutation variables
   * @returns Typed response data
   */
  async mutate<T>(
    mutation: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    return this.request<T>(mutation, variables);
  }
}
