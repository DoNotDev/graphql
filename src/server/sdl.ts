// packages/providers/graphql/src/server/sdl.ts

/**
 * @fileoverview SDL fragment generator for the bulk CRUD mutation.
 * @description Produces the GraphQL SDL shape that matches what
 *   {@link createBulkResolver} expects and what `GraphQLCrudAdapter.bulk()`
 *   sends over the wire. Emit once per bulk-enabled entity and concat into
 *   your schema string (or feed into your schema builder).
 *
 *   The fragment uses a `JSON` scalar for opaque row/patch shapes (row-level
 *   validation happens server-side via the entity's Valibot schema). Consumers
 *   MUST define a `scalar JSON` (e.g. `graphql-scalars` `GraphQLJSON`) in
 *   their schema — this module does not bundle a scalar resolver because that
 *   couples us to a specific GraphQL server.
 *
 * @version 0.1.0
 * @since 0.7.0
 * @author AMBROISE PARK Consulting
 */

// =============================================================================
// Helpers
// =============================================================================

/** Capitalize first character. Same rule used by `GraphQLCrudAdapter.bulk()`. */
function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// =============================================================================
// SDL generator
// =============================================================================

/**
 * Parameters for {@link bulkSDL}.
 *
 * @version 0.1.0
 * @since 0.7.0
 */
export interface BulkSDLParams {
  /**
   * Collection name (lower-case plural convention, e.g. `events`). Used to
   * derive the mutation name (`bulkEvents`), input type (`EventsBulkInput`),
   * and result type (`EventsBulkResult`).
   */
  collection: string;
  /**
   * Entity type name — reserved for future `insertedIds`/`updatedIds`
   * associations to the underlying entity. Currently recorded for
   * documentation; the fragment returns ids only (preserving the atomic
   * wire contract used by `GraphQLCrudAdapter.bulk()`).
   */
  entityType: string;
}

/**
 * SDL fragment for the `bulk${Collection}` mutation. Paste into your schema
 * string or concat into your type-defs list.
 *
 * Shape produced (for `collection: 'events'`):
 *
 * ```graphql
 * input EventsBulkUpdate {
 *   id: ID!
 *   patch: JSON!
 * }
 *
 * input EventsBulkInput {
 *   inserts: [JSON!]
 *   updates: [EventsBulkUpdate!]
 *   deletes: [ID!]
 * }
 *
 * type EventsBulkResult {
 *   insertedIds: [ID!]!
 *   updatedIds: [ID!]!
 *   deletedIds: [ID!]!
 * }
 *
 * extend type Mutation {
 *   bulkEvents(input: EventsBulkInput!): EventsBulkResult!
 * }
 * ```
 *
 * **JSON scalar:** the returned SDL references a `JSON` scalar that MUST be
 * declared in your root schema. With `graphql-scalars`:
 *
 * ```ts
 * import { GraphQLJSON } from 'graphql-scalars';
 *
 * const baseSchema = `scalar JSON`;
 * const resolvers = { JSON: GraphQLJSON, Mutation: { bulkEvents: … } };
 * ```
 *
 * @param params - {@link BulkSDLParams}.
 * @returns SDL fragment string (trimmed).
 *
 * @example
 * ```ts
 * import { bulkSDL } from '@donotdev/graphql/server';
 *
 * const typeDefs = [
 *   `scalar JSON`,
 *   existingSchema,
 *   bulkSDL({ collection: 'events', entityType: 'Event' }),
 * ].join('\n');
 * ```
 *
 * @version 0.1.0
 * @since 0.7.0
 * @author AMBROISE PARK Consulting
 */
export function bulkSDL(params: BulkSDLParams): string {
  const { collection } = params;
  if (collection.length === 0) {
    throw new Error('bulkSDL: `collection` must be a non-empty string');
  }
  const cap = capitalize(collection);
  return `input ${cap}BulkUpdate {
  id: ID!
  patch: JSON!
}

input ${cap}BulkInput {
  inserts: [JSON!]
  updates: [${cap}BulkUpdate!]
  deletes: [ID!]
}

type ${cap}BulkResult {
  insertedIds: [ID!]!
  updatedIds: [ID!]!
  deletedIds: [ID!]!
}

extend type Mutation {
  bulk${cap}(input: ${cap}BulkInput!): ${cap}BulkResult!
}`;
}
