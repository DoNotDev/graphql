// packages/providers/graphql/src/server/bulkResolver.ts

/**
 * @fileoverview Framework-agnostic GraphQL bulk CRUD resolver factory.
 * @description Returns a plain `(parent, args, context, info) => Promise<BulkResponse>`
 *   resolver that can be wired into any GraphQL server (Apollo, Yoga, Pothos,
 *   Mercurius, …). All bulk policy — wire validation, collision detection,
 *   per-bucket ACL, per-row schema validation, id minting, metadata stamping,
 *   audit, response validation — lives in `executeBulk` from
 *   `@donotdev/functions/shared`. This factory is a thin GraphQL-shaped
 *   forwarder; it does NOT bind to a specific GraphQL server.
 *
 *   Storage is caller-owned via `transact`. GraphQL consumers pick their ORM
 *   (Prisma, Drizzle, TypeORM, raw pg) — the factory never imports one.
 *
 * @version 0.1.0
 * @since 0.7.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { BulkRequestSchema, DoNotDevError } from '@donotdev/core/server';
import type {
  BulkRequest,
  BulkResponse,
  EntityAccessConfig,
  Entity,
  UserRole,
  dndevSchema,
} from '@donotdev/core/server';
import { executeBulk } from '@donotdev/functions/shared';
import type { ExecuteBulkParams } from '@donotdev/functions/shared';

// =============================================================================
// Public types
// =============================================================================

/**
 * Options for {@link createBulkResolver}. Mirrors the subset of
 * {@link ExecuteBulkParams} that callers must supply — `collection`, `ops`,
 * `uid`, and `userRole` are derived by the resolver from the entity + GraphQL
 * context at call time.
 *
 * @template TRow - Row type for documentation; runtime is opaque.
 *
 * @version 0.1.0
 * @since 0.7.0
 */
export interface CreateBulkResolverOptions<TRow = unknown> {
  /**
   * Entity declaration. `entity.collection` is forwarded to {@link executeBulk}
   * as the target collection name used for audit + error messages.
   */
  entity: Entity;
  /** Valibot schema validating each insert row (from `createSchemas(entity).create`). */
  createSchema: dndevSchema<TRow>;
  /** Valibot schema validating each update patch (from `createSchemas(entity).update`). */
  updateSchema: dndevSchema<Partial<TRow>>;
  /** Per-bucket required roles. Typically `entity.access`. */
  access: EntityAccessConfig;
  /**
   * Caller-provided storage. Receives prepared inserts/updates/deletes with
   * ids minted and metadata stamped, and MUST run them in ONE database
   * transaction, returning the ids per bucket in input order.
   *
   * Why not ship a default? GraphQL consumers pick their own ORM (Prisma,
   * Drizzle, TypeORM, raw pg). We don't bind to one.
   *
   * @example
   * ```ts
   * // Prisma
   * transact: async ({ inserts, updates, deletes }) =>
   *   prisma.$transaction(async (tx) => {
   *     const insertedIds: string[] = [];
   *     for (const { row } of inserts) {
   *       const created = await tx.event.create({ data: row });
   *       insertedIds.push(created.id);
   *     }
   *     for (const { id, patch } of updates) {
   *       await tx.event.update({ where: { id }, data: patch });
   *     }
   *     if (deletes.length > 0) {
   *       await tx.event.deleteMany({ where: { id: { in: deletes } } });
   *     }
   *     return {
   *       insertedIds,
   *       updatedIds: updates.map((u) => u.id),
   *       deletedIds: deletes,
   *     };
   *   });
   * ```
   */
  transact: ExecuteBulkParams<TRow>['transact'];
  /**
   * Optional id minter. Omit when the storage layer mints its own ids (Prisma
   * `@default(uuid())`, Postgres `gen_random_uuid()`, …). Supply when you need
   * ids stamped up-front (raw SQL, targets that echo the client id verbatim).
   *
   * @example
   * ```ts
   * mintInsertId: () => crypto.randomUUID(),
   * ```
   */
  mintInsertId?: ExecuteBulkParams<TRow>['mintInsertId'];
  /** Optional per-insert metadata stamp (timestamps, createdById, …). */
  stampInsertMetadata?: ExecuteBulkParams<TRow>['stampInsertMetadata'];
  /** Optional per-update metadata stamp (updatedAt, updatedById, …). */
  stampUpdateMetadata?: ExecuteBulkParams<TRow>['stampUpdateMetadata'];
  /** Optional audit hook; fires once with op counts on success. */
  audit?: ExecuteBulkParams<TRow>['audit'];
}

/**
 * GraphQL context required by the generated resolver. Consumers adapt their
 * server context to this shape (Apollo `context` builder, Yoga `context`
 * function, Pothos context type).
 *
 * @version 0.1.0
 * @since 0.7.0
 */
export interface BulkGraphqlContext {
  /** Authenticated caller id. */
  uid: string;
  /** Caller's role (for per-bucket ACL). */
  userRole: UserRole;
}

/**
 * Standard GraphQL resolver shape: `(parent, args, context, info) => Promise<…>`.
 * Returned by {@link createBulkResolver}.
 *
 * @version 0.1.0
 * @since 0.7.0
 */
export type BulkGraphqlResolver = (
  parent: unknown,
  args: { input: BulkRequest },
  context: BulkGraphqlContext,
  info?: unknown
) => Promise<BulkResponse>;

// =============================================================================
// Factory
// =============================================================================

/**
 * Build a framework-agnostic GraphQL resolver for `bulk${Collection}`.
 *
 * The returned resolver has the canonical
 * `(parent, args, context, info) => Promise<BulkResponse>` shape, so it mounts
 * into any GraphQL server. All bulk semantics (atomicity contract, collision
 * rejection, per-bucket ACL, per-row validation, audit) are enforced by
 * {@link executeBulk} in `@donotdev/functions/shared` — this factory only:
 *
 *   1. Validates `args.input` against {@link BulkRequestSchema} at the GraphQL
 *      boundary (so malformed input surfaces as a clean schema error before
 *      `executeBulk` re-parses it).
 *   2. Forwards the three buckets + `ctx.uid` + `ctx.userRole` to
 *      `executeBulk`, letting it own id minting, metadata stamping, and the
 *      atomic `transact` dispatch.
 *
 * The resolver name expected by the generated mutation is `bulk${Cap}` where
 * `Cap` is the capitalized collection name (e.g. `events` → `bulkEvents`,
 * input type `EventsBulkInput`, result type `EventsBulkResult`). See
 * {@link bulkSDL} for the matching SDL fragment.
 *
 * **Transaction requirement:** `transact` MUST run all three buckets in ONE
 * database transaction. Returning partial success is a contract violation —
 * {@link executeBulk} validates the shape of the return value but cannot
 * detect a non-atomic commit.
 *
 * @template TRow - Row type for the collection (documentation only).
 * @param options - Factory options. See {@link CreateBulkResolverOptions}.
 * @returns A GraphQL resolver function of shape {@link BulkGraphqlResolver}.
 *
 * @example
 * ```ts
 * // Apollo Server 4
 * import { ApolloServer } from '@apollo/server';
 * import { createBulkResolver, bulkSDL } from '@donotdev/graphql/server';
 * import { createSchemas } from '@donotdev/core/server';
 *
 * const { create, update } = createSchemas(eventEntity);
 *
 * const resolvers = {
 *   Mutation: {
 *     bulkEvents: createBulkResolver({
 *       entity: eventEntity,
 *       createSchema: create,
 *       updateSchema: update,
 *       access: eventEntity.access,
 *       transact: prismaTransact,
 *     }),
 *   },
 * };
 *
 * const server = new ApolloServer({
 *   typeDefs: [baseSchema, bulkSDL({ collection: 'events', entityType: 'Event' })],
 *   resolvers,
 * });
 * ```
 *
 * @example
 * ```ts
 * // GraphQL Yoga — identical resolver shape, just different server wiring.
 * import { createYoga, createSchema } from 'graphql-yoga';
 * import { createBulkResolver } from '@donotdev/graphql/server';
 *
 * const yoga = createYoga({
 *   schema: createSchema({
 *     typeDefs,
 *     resolvers: {
 *       Mutation: {
 *         bulkEvents: createBulkResolver({ … }),
 *       },
 *     },
 *   }),
 * });
 * ```
 *
 * @example
 * ```ts
 * // Pothos
 * builder.mutationField('bulkEvents', (t) =>
 *   t.field({
 *     type: BulkEventsResult,
 *     args: { input: t.arg({ type: EventsBulkInput, required: true }) },
 *     resolve: createBulkResolver({ … }),
 *   })
 * );
 * ```
 *
 * @version 0.1.0
 * @since 0.7.0
 * @author AMBROISE PARK Consulting
 */
export function createBulkResolver<TRow = unknown>(
  options: CreateBulkResolverOptions<TRow>
): BulkGraphqlResolver {
  const {
    entity,
    createSchema,
    updateSchema,
    access,
    transact,
    mintInsertId,
    stampInsertMetadata,
    stampUpdateMetadata,
    audit,
  } = options;

  return async (_parent, args, ctx) => {
    // 1. GraphQL-boundary input validation. `executeBulk` re-parses, but
    //    rejecting malformed input HERE gives consumers a clean schema error
    //    before any downstream work (audit, ACL check, schema lookup).
    const parsed = v.safeParse(BulkRequestSchema, args?.input);
    if (!parsed.success) {
      const messages = parsed.issues
        .map((issue) => {
          const path = issue.path
            ?.map((p) => String((p as { key: unknown }).key))
            .join('.');
          return `${path || 'root'}: ${issue.message}`;
        })
        .join('; ');
      throw new DoNotDevError(
        `Bulk input failed GraphQL boundary validation: ${messages}`,
        'invalid-argument',
        { details: { validationErrors: parsed.issues } }
      );
    }

    // 2. Forward to the shared orchestrator. executeBulk owns all policy.
    return executeBulk({
      collection: entity.collection,
      ops: parsed.output,
      createSchema: createSchema as ExecuteBulkParams<TRow>['createSchema'],
      updateSchema: updateSchema as ExecuteBulkParams<TRow>['updateSchema'],
      access,
      uid: ctx.uid,
      userRole: ctx.userRole,
      mintInsertId,
      stampInsertMetadata,
      stampUpdateMetadata,
      audit,
      transact,
    });
  };
}
