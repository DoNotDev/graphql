// packages/providers/graphql/src/client/callableProvider.ts

/**
 * @fileoverview GraphQL Callable Provider
 * @description ICallableProvider implementation using a GraphQL API endpoint.
 * Maps `call(functionName, data)` to a GraphQL mutation named after the function.
 *
 * @version 0.0.1
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { ICallableProvider } from '@donotdev/core';
import { wrapCrudError, DoNotDevError } from '@donotdev/core';

import type { GraphQLClient } from './graphqlClient';

// =============================================================================
// GraphQLCallableProvider
// =============================================================================

/**
 * Invokes server-side functions via GraphQL mutations.
 * The function name is used directly as the mutation name.
 *
 * @example
 * ```typescript
 * const callable = new GraphQLCallableProvider(client);
 * const result = await callable.call('deleteAccount', { userId: '123' });
 * // → mutation { deleteAccount(input: { userId: "123" }) }
 * ```
 *
 * @version 0.0.1
 * @since 0.0.1
 */
export class GraphQLCallableProvider implements ICallableProvider {
  constructor(private readonly client: GraphQLClient) {}

  async call<TReq, TRes>(functionName: string, data: TReq): Promise<TRes> {
    try {
      const mutation = `
        mutation Call_${functionName}($input: JSON) {
          ${functionName}(input: $input)
        }
      `;

      const result = await this.client.mutate<Record<string, unknown>>(
        mutation,
        { input: data as Record<string, unknown> }
      );

      return result[functionName] as TRes;
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'GraphQLCallableProvider',
        'call',
        functionName
      );
    }
  }
}
