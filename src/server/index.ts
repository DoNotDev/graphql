// packages/providers/graphql/src/server/index.ts

/**
 * @donotdev/graphql/server — Server-only exports.
 *
 * Framework-agnostic GraphQL aids for consumer GraphQL servers (Apollo, Yoga,
 * Pothos, Mercurius). Currently exposes the `createBulkResolver` factory and
 * matching `bulkSDL` fragment generator for the transactional bulk CRUD
 * mutation. All policy (wire validation, collision detection, per-bucket ACL,
 * per-row validation, audit) is owned by `executeBulk` from
 * `@donotdev/functions/shared` — nothing in this subtree binds to a specific
 * GraphQL server.
 *
 * @packageDocumentation
 */

export * from './bulkResolver';
export * from './sdl';
