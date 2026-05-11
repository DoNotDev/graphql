# @donotdev/graphql

GraphQL provider for DoNotDev — CRUD, auth, and server aids.

Two entry points:

- `@donotdev/graphql` — client: `GraphQLCrudAdapter`, `GraphQLClient`.
- `@donotdev/graphql/server` — server: `createBulkResolver`, `bulkSDL`.

---

## Client

The client provider ships a `GraphQLCrudAdapter` that implements
`ICrudAdapter` on top of a plain GraphQL HTTP endpoint. It maps CRUD
operations to conventional mutation / query names (`createUsers`,
`updateUsers`, `bulkUsers`, …) and validates wire payloads against the shared
core schemas. No real-time subscriptions — subscribe/subscribeToCollection
are intentionally not implemented.

See `src/client/crudAdapter.ts` for the full mapping.

---

## Server — bulk resolver

`@donotdev/graphql/server` exposes a framework-agnostic resolver factory that
consumer GraphQL servers mount to satisfy the `bulk${Collection}` mutation
emitted by `GraphQLCrudAdapter.bulk()`.

### What it does

`createBulkResolver(options)` returns a plain
`(parent, args, context, info) => Promise<BulkResponse>` function. It:

1. Validates `args.input` against `BulkRequestSchema` at the GraphQL
   boundary so malformed input surfaces as a clean schema error.
2. Forwards the parsed wire body + `ctx.uid` + `ctx.userRole` to
   `executeBulk` (from `@donotdev/functions/shared`), which owns all bulk
   policy: collision detection, per-bucket ACL, per-row validation, id
   minting, metadata stamping, atomic `transact` dispatch, response
   validation, audit.

All storage is caller-owned — the factory never imports an ORM. You supply
a `transact` callback that MUST run the three buckets inside one database
transaction and return the ids per bucket in input order.

### SDL fragment

Use `bulkSDL()` to generate the matching SDL per bulk-enabled entity. The
fragment uses a `JSON` scalar for opaque row / patch shapes — define one in
your root schema (e.g. via `graphql-scalars` `GraphQLJSON`).

```ts
import { bulkSDL } from '@donotdev/graphql/server';

const typeDefs = [
  `scalar JSON`,
  existingSchema,
  bulkSDL({ collection: 'events', entityType: 'Event' }),
].join('\n');
```

Produces:

```graphql
input EventsBulkUpdate {
  id: ID!
  patch: JSON!
}

input EventsBulkInput {
  inserts: [JSON!]
  updates: [EventsBulkUpdate!]
  deletes: [ID!]
}

type EventsBulkResult {
  insertedIds: [ID!]!
  updatedIds: [ID!]!
  deletedIds: [ID!]!
}

extend type Mutation {
  bulkEvents(input: EventsBulkInput!): EventsBulkResult!
}
```

### Apollo Server 4

```ts
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { GraphQLJSON } from 'graphql-scalars';

import { createBulkResolver, bulkSDL } from '@donotdev/graphql/server';
import { createSchemas } from '@donotdev/core/server';

import { eventEntity } from './entities/event.js';
import { prismaTransact } from './db/prismaBulk.js';

const { create, update } = createSchemas(eventEntity);

const typeDefs = [
  `scalar JSON`,
  bulkSDL({ collection: 'events', entityType: 'Event' }),
].join('\n');

const resolvers = {
  JSON: GraphQLJSON,
  Mutation: {
    bulkEvents: createBulkResolver({
      entity: eventEntity,
      createSchema: create,
      updateSchema: update,
      access: eventEntity.access,
      transact: prismaTransact,
    }),
  },
};

const server = new ApolloServer({ typeDefs, resolvers });
await startStandaloneServer(server, {
  context: async ({ req }) => ({
    uid: await resolveUid(req),
    userRole: await resolveRole(req),
  }),
});
```

### GraphQL Yoga

```ts
import { createYoga, createSchema } from 'graphql-yoga';
import { GraphQLJSON } from 'graphql-scalars';

import { createBulkResolver, bulkSDL } from '@donotdev/graphql/server';

const yoga = createYoga({
  schema: createSchema({
    typeDefs: [
      `scalar JSON`,
      bulkSDL({ collection: 'events', entityType: 'Event' }),
    ],
    resolvers: {
      JSON: GraphQLJSON,
      Mutation: {
        bulkEvents: createBulkResolver({ /* … */ }),
      },
    },
  }),
  context: ({ request }) => ({
    uid: resolveUid(request),
    userRole: resolveRole(request),
  }),
});
```

### Pothos

```ts
import SchemaBuilder from '@pothos/core';
import { createBulkResolver } from '@donotdev/graphql/server';

const builder = new SchemaBuilder<{
  Context: { uid: string; userRole: UserRole };
  Scalars: { JSON: { Input: unknown; Output: unknown } };
}>({});

builder.scalarType('JSON', { /* … */ });

const EventsBulkUpdate = builder.inputType('EventsBulkUpdate', {
  fields: (t) => ({ id: t.id({ required: true }), patch: t.field({ type: 'JSON', required: true }) }),
});

const EventsBulkInput = builder.inputType('EventsBulkInput', {
  fields: (t) => ({
    inserts: t.field({ type: ['JSON'] }),
    updates: t.field({ type: [EventsBulkUpdate] }),
    deletes: t.idList(),
  }),
});

const EventsBulkResult = builder.objectRef<BulkResponse>('EventsBulkResult').implement({
  fields: (t) => ({
    insertedIds: t.exposeIDList('insertedIds'),
    updatedIds: t.exposeIDList('updatedIds'),
    deletedIds: t.exposeIDList('deletedIds'),
  }),
});

builder.mutationField('bulkEvents', (t) =>
  t.field({
    type: EventsBulkResult,
    args: { input: t.arg({ type: EventsBulkInput, required: true }) },
    resolve: createBulkResolver({ /* … */ }),
  })
);
```

### Transaction requirement (non-negotiable)

`transact` MUST run all three buckets inside one database transaction. The
atomicity contract is part of the bulk semantics — a partial commit is a
contract violation that `executeBulk` cannot detect (it can only validate the
shape of the return value).

```ts
// Prisma
transact: async ({ inserts, updates, deletes }) =>
  prisma.$transaction(async (tx) => {
    const insertedIds: string[] = [];
    for (const { row } of inserts) {
      const created = await tx.event.create({ data: row });
      insertedIds.push(created.id);
    }
    for (const { id, patch } of updates) {
      await tx.event.update({ where: { id }, data: patch });
    }
    if (deletes.length > 0) {
      await tx.event.deleteMany({ where: { id: { in: deletes } } });
    }
    return {
      insertedIds,
      updatedIds: updates.map((u) => u.id),
      deletedIds: deletes,
    };
  });
```

### Shared semantics

The full contract — collision detection, per-bucket ACL, validation order,
empty short-circuit, response-shape check, audit — lives in
`@donotdev/functions/shared` (`executeBulk`). Read that module once and it
applies uniformly across Firestore admin, Supabase RPC, and this GraphQL
resolver.
