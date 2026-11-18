// packages/providers/graphql/src/client/crudAdapter.ts

/**
 * @fileoverview GraphQL CRUD Adapter
 * @description ICrudAdapter implementation using a GraphQL API endpoint.
 * Maps CRUD operations to GraphQL queries/mutations using dynamic query construction.
 * No real-time subscriptions — subscribe/subscribeToCollection are not implemented.
 *
 * **Collection naming:** collection name is used directly as the GraphQL type name.
 * `get('users', id)` → `query { users(id: $id) { ... } }`
 * `add('users', data)` → `mutation { createUsers(input: $input) { id ... } }`
 *
 * @version 0.0.1
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  BulkCollisionError,
  BulkRequestSchema,
  validateBulkOutcome,
  CRUD_OPERATORS,
  DoNotDevError,
  detectBulkCollisions,
  wrapCrudError,
} from '@donotdev/core';
import type {
  BulkOperations,
  BulkResult,
  ICrudAdapter,
  QueryOptions,
  PaginatedQueryResult,
  CrudOperator,
  CrudOperationOptions,
  dndevSchema,
} from '@donotdev/core';

import type { GraphQLClient } from './graphqlClient';

// =============================================================================
// Helpers
// =============================================================================

/** Capitalize first letter — used to build mutation names (createUsers, deleteUsers). */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A record returned by a query (the selection is built at runtime). */
const RECORD_SCHEMA = v.record(v.string(), v.unknown());
/** A record returned by a create mutation: it must carry a string id. */
const CREATED_RECORD_SCHEMA = v.looseObject({ id: v.string() });

/**
 * Derive GraphQL field selection from a valibot schema's entries.
 * Always includes `id`. Falls back to `id` only if schema is absent or has no entries.
 */
function buildFieldSelection(schema?: dndevSchema<unknown>): string {
  const entries =
    schema && 'entries' in schema && typeof schema.entries === 'object'
      ? schema.entries
      : undefined;
  if (!entries) return 'id';
  const fields = new Set(['id', ...Object.keys(entries)]);
  return Array.from(fields).join('\n            ');
}

/**
 * Build a GraphQL argument string from a filter value.
 * Strings are quoted, everything else is JSON-serialized inline.
 */
function gqlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value) ?? 'null';
}

/**
 * Map a CrudOperator to a GraphQL filter argument fragment.
 * Returns `null` for unsupported operators (they are skipped in query construction).
 */
function operatorToGqlFilter(
  field: string,
  operator: CrudOperator,
  value: unknown
): string | null {
  switch (operator) {
    case CRUD_OPERATORS.EQ:
      return `${field}: ${gqlValue(value)}`;
    case CRUD_OPERATORS.NEQ:
      return `${field}_neq: ${gqlValue(value)}`;
    case CRUD_OPERATORS.LT:
      return `${field}_lt: ${gqlValue(value)}`;
    case CRUD_OPERATORS.LTE:
      return `${field}_lte: ${gqlValue(value)}`;
    case CRUD_OPERATORS.GT:
      return `${field}_gt: ${gqlValue(value)}`;
    case CRUD_OPERATORS.GTE:
      return `${field}_gte: ${gqlValue(value)}`;
    case CRUD_OPERATORS.IN:
      return `${field}_in: ${JSON.stringify(Array.isArray(value) ? value : [value])}`;
    case CRUD_OPERATORS.NOT_IN:
      return `${field}_notIn: ${JSON.stringify(Array.isArray(value) ? value : [value])}`;
    default:
      return null;
  }
}

/**
 * Build filter arguments string from QueryOptions.where.
 * Returns empty string when there are no clauses.
 */
function buildFilterArgs(options: QueryOptions): string {
  const clauses: string[] = [];

  if (options.where) {
    for (const clause of options.where) {
      const fragment = operatorToGqlFilter(
        clause.field,
        clause.operator,
        clause.value
      );
      if (fragment !== null) clauses.push(fragment);
    }
  }

  if (options.orderBy && options.orderBy.length > 0) {
    const ob = options.orderBy[0];
    if (ob) {
      clauses.push(
        `orderBy: "${ob.field}"`,
        `orderDir: "${ob.direction ?? 'asc'}"`
      );
    }
  }

  if (options.limit !== undefined) {
    clauses.push(`limit: ${options.limit}`);
  }

  if (options.startAfter) {
    clauses.push(`after: ${JSON.stringify(options.startAfter)}`);
  }

  return clauses.length > 0 ? `(${clauses.join(', ')})` : '';
}

// =============================================================================
// GraphQLCrudAdapter
// =============================================================================

/**
 * GraphQL CRUD adapter. Maps DoNotDev CRUD operations to GraphQL queries/mutations.
 * Collection name is used as the GraphQL type name (e.g. `users` → `getUsers`).
 *
 * No real-time subscriptions — subscribe/subscribeToCollection are not provided.
 *
 * @version 0.0.1
 * @since 0.0.1
 */
export class GraphQLCrudAdapter implements ICrudAdapter {
  /**
   * GraphQL security is handled by the server (JWT-based auth in headers).
   * There is no DB-level RLS equivalent here.
   */
  readonly serverSideOnly = false;
  readonly dbLevelSecurity = false;

  constructor(private readonly client: GraphQLClient) {}

  async get<T>(
    collection: string,
    id: string,
    schema?: dndevSchema<unknown>,
    options?: CrudOperationOptions
  ): Promise<T | null> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }

    try {
      const fields = buildFieldSelection(schema);
      const query = `
        query Get${capitalize(collection)}($id: ID!) {
          ${collection}(id: $id) {
            ${fields}
          }
        }
      `;

      // Use variables for safe injection
      const data = await this.client.query<Record<string, unknown>>(query, {
        id,
      });

      const record = data[collection];
      if (record === null || record === undefined) return null;
      // Include document ID in result (mirrors FirestoreAdapter contract)
      // why: `T` is caller-asserted (ICrudAdapter); the record is shape-checked, not validated against `T`
      return { ...v.parse(RECORD_SCHEMA, record), id } as T;
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      // Treat "not found" errors as null
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('not found') ||
        message.includes('Not Found') ||
        message.includes('does not exist')
      ) {
        return null;
      }
      throw wrapCrudError(
        error instanceof Error ? error : new Error(message),
        'GraphQLCrudAdapter',
        'get',
        collection,
        id
      );
    }
  }

  async add<T>(
    collection: string,
    data: T,
    _schema?: dndevSchema<T>,
    options?: CrudOperationOptions
  ): Promise<{ id: string; data: Record<string, unknown> }> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }

    try {
      const mutation = `
        mutation Create${capitalize(collection)}($input: JSON!) {
          create${capitalize(collection)}(input: $input) {
            id
          }
        }
      `;

      const result = await this.client.mutate<Record<string, unknown>>(
        mutation,
        // why: add<T>'s `T` is unconstrained (ICrudAdapter); entity input is a JSON object by contract
        { input: data as Record<string, unknown> }
      );

      const created = v.safeParse(
        CREATED_RECORD_SCHEMA,
        result[`create${capitalize(collection)}`]
      );
      if (!created.success) {
        throw new Error('Create mutation returned no id');
      }
      const record = created.output;

      return { id: record.id, data: record };
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'GraphQLCrudAdapter',
        'add',
        collection
      );
    }
  }

  async set<T>(
    collection: string,
    id: string,
    data: T,
    _schema?: dndevSchema<T>,
    options?: CrudOperationOptions
  ): Promise<Record<string, unknown>> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }

    try {
      const mutation = `
        mutation Upsert${capitalize(collection)}($id: ID!, $input: JSON!) {
          upsert${capitalize(collection)}(id: $id, input: $input) {
            id
          }
        }
      `;

      // why: `T` is unconstrained (ICrudAdapter); entity input is a JSON object by contract
      const input = data as Record<string, unknown>;
      await this.client.mutate(mutation, { id, input });
      // The generic JSON mutation selects only `id`: the input is what was stored.
      return { ...input, id };
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'GraphQLCrudAdapter',
        'set',
        collection,
        id
      );
    }
  }

  async update<T>(
    collection: string,
    id: string,
    data: Partial<T>,
    options?: CrudOperationOptions
  ): Promise<Record<string, unknown>> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }

    try {
      const mutation = `
        mutation Update${capitalize(collection)}($id: ID!, $input: JSON!) {
          update${capitalize(collection)}(id: $id, input: $input) {
            id
          }
        }
      `;

      // why: `T` is unconstrained (ICrudAdapter); entity input is a JSON object by contract
      const input = data as Record<string, unknown>;
      await this.client.mutate(mutation, { id, input });
      // The generic JSON mutation selects only `id`: the patch is what was stored.
      return { ...input, id };
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'GraphQLCrudAdapter',
        'update',
        collection,
        id
      );
    }
  }

  async delete(
    collection: string,
    id: string,
    options?: CrudOperationOptions
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }

    try {
      const mutation = `
        mutation Delete${capitalize(collection)}($id: ID!) {
          delete${capitalize(collection)}(id: $id) {
            success
          }
        }
      `;

      await this.client.mutate(mutation, { id });
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'GraphQLCrudAdapter',
        'delete',
        collection,
        id
      );
    }
  }

  /**
   * Bulk transactional operation — single GraphQL mutation resolved atomically
   * by the consumer's server (all-or-nothing). The client only owes the
   * mutation shape; server wiring lands in Wave II via the resolver factory.
   *
   * Wire shape:
   * `mutation Bulk${Collection}($input: ${Collection}BulkInput!) { bulk${Collection}(input: $input) { insertedIds updatedIds deletedIds } }`
   *
   * Contract (server-enforced, mirrored client-side):
   *   1. Atomic — all ops commit or none do.
   *   2. Collision rejection — same id in `updates`+`deletes` or
   *      `inserts`+`updates` throws {@link BulkCollisionError} **before** any
   *      network call. Re-thrown unwrapped so callers can `instanceof` it.
   *   3. Empty bulk short-circuits to a zeroed result with no GraphQL call.
   *   4. Input order preserved per bucket in the returned ids.
   *   5. Response validated against {@link validateBulkOutcome} — drift fails loud.
   *
   * @example
   * const result = await adapter.bulk('events', {
   *   inserts: [{ title: 'A' }],
   *   updates: [{ id: 'e1', patch: { title: 'renamed' } }],
   *   deletes: ['e2'],
   * });
   * result.insertedIds; // ['evt_…']
   * result.updatedIds;  // ['e1']
   * result.deletedIds;  // ['e2']
   */
  async bulk<T extends Record<string, unknown>>(
    collection: string,
    ops: BulkOperations<T>,
    _schema?: dndevSchema<T>,
    options?: CrudOperationOptions
  ): Promise<BulkResult> {
    if (options?.signal?.aborted) throw new Error('Operation cancelled');

    const inserts = ops.inserts ?? [];
    const updates = ops.updates ?? [];
    const deletes = ops.deletes ?? [];

    // 1. Collision detection — thrown unwrapped so consumers can `instanceof`.
    const collision = detectBulkCollisions({ inserts, updates, deletes });
    if (collision.where !== null) {
      throw new BulkCollisionError(collision.collisions, collision.where);
    }

    // 2. Empty short-circuit — no network call, zeroed result.
    if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) {
      return { insertedIds: [], updatedIds: [], deletedIds: [], failed: [] };
    }

    try {
      // 3. Validate wire body at the boundary.
      const wireBody = v.parse(BulkRequestSchema, {
        inserts,
        updates,
        deletes,
      });

      // 4. Keep the legacy atomic selection: bulkSDL does not expose failed.
      // GraphQL projects only selected fields: partial failures cannot reach this
      // client over a compliant server response. Incomplete acknowledgements
      // fail as unknown. Selecting failed requires a deployed server schema and
      // a negotiated client capability; neither is provided by this protocol.
      const typeName = capitalize(collection);
      const mutation = `
        mutation Bulk${typeName}($input: ${typeName}BulkInput!) {
          bulk${typeName}(input: $input) {
            insertedIds
            updatedIds
            deletedIds
          }
        }
      `;

      // 5. Dispatch + validate response — drift surfaces as a parse error.
      const data = await this.client.mutate<Record<string, unknown>>(mutation, {
        input: wireBody,
      });
      return validateBulkOutcome(wireBody, data[`bulk${typeName}`]);
    } catch (error) {
      // Collision is thrown outside try; everything else is transport/server/drift.
      if (error instanceof DoNotDevError) throw error;
      throw wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'GraphQLCrudAdapter',
        'bulk',
        collection
      );
    }
  }

  async query<T>(
    collection: string,
    options: QueryOptions,
    schema?: dndevSchema<unknown>,
    _schemaType?: string,
    operationOptions?: CrudOperationOptions
  ): Promise<PaginatedQueryResult<T>> {
    if (operationOptions?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }

    try {
      const fields = buildFieldSelection(schema);
      const filterArgs = buildFilterArgs(options);
      const queryDoc = `
        query List${capitalize(collection)} {
          ${collection}${filterArgs} {
            items {
              ${fields}
            }
            total
            hasMore
            lastVisible
          }
        }
      `;

      const data = await this.client.query<Record<string, unknown>>(queryDoc);
      // why: list items are the caller-asserted `T` (ICrudAdapter); no row schema here
      const result = data[collection] as {
        items?: T[];
        total?: number;
        hasMore?: boolean;
        lastVisible?: string | null;
      } | null;

      if (!result) {
        return { items: [], total: 0, hasMore: false, lastVisible: null };
      }

      return {
        items: result.items ?? [],
        total: result.total,
        hasMore: result.hasMore ?? false,
        lastVisible: result.lastVisible ?? null,
      };
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'GraphQLCrudAdapter',
        'query',
        collection
      );
    }
  }

  // subscribe and subscribeToCollection are not implemented — GraphQL subscriptions
  // require a WebSocket transport not included in this minimal provider.
}
