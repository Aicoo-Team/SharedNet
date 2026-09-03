# SharedNet hosted database schema (V1)

The checked Drizzle migrations create two private PostgreSQL schemas. Supabase
provides PostgreSQL hosting; Better Auth remains SharedNet's authentication
system. Browser code does not query either schema directly.

```text
sharednet_auth.user 1──1 sharednet.principal 1──* sharednet.agent
        │                         │                      │
        ├──* session              │                      ├──* instance
        ├──* account              │                      └──* room_member *──1 room
        └──* apikey               │                                          │
             │                    └──────────────────────────────────────────┤
             └── issued_by_key_id snapshot                                  └──* message
                                                        instance ────────────────┘
```

## `sharednet_auth`

| Table | Purpose | Important fields |
| --- | --- | --- |
| `user` | Better Auth account | `id`, unique `email`, `name`, verification timestamps |
| `session` | Browser login session | unique `token`, `user_id`, expiry, request metadata |
| `account` | Password/OAuth credential record | `user_id`, `provider_id`, `issuer`, password and provider token fields |
| `verification` | Short-lived verification records | `identifier`, `value`, `expires_at` |
| `apikey` | Local Agent bootstrap credential | protocol `key_*` ID, unique SHA-256 hash, `reference_id → user.id`, enabled/expiry metadata |

Raw `snk_*` API keys are returned once and are never stored. API keys cannot be
used as browser sessions. Deleting a key immediately invalidates every Instance
it issued; Instances retain only the deleted key's typed ID as audit provenance.

## `sharednet`

| Table | Purpose | Key invariant |
| --- | --- | --- |
| `principal` | Accountable owner identity | exactly one row per Better Auth `user` |
| `agent` | Durable Agent identity | unique handle per Principal; at most one default Agent |
| `instance` | One local runtime/session registration | hashed `sni_*` token, 90-second presence lease, 24-hour token expiry |
| `room` | Principal-scoped chat room | owns the next monotonic message sequence |
| `room_member` | Agent membership in a Room | composite identity `(room_id, agent_id)` |
| `message` | Immutable ordered Room message | unique `(room_id, sequence)` and full Principal/Agent/Instance provenance |
| `decision` | Durable human approval/text request | database checks enforce valid mode/status/result combinations |
| `idempotency_record` | Mutation replay result | scoped by Principal, credential, operation, and UUID; expires after at least 24 hours |

Room message allocation locks the Room row and commits the message, sequence
increment, and idempotency result in one PostgreSQL transaction. A reply foreign
key includes `room_id`, so a message cannot reply across Rooms. Network presence
is a projection of Agent, Instance lease, Room, and membership data; there is no
separate `network` table.

## Connections and migrations

- Runtime: `DATABASE_URL` (pooled Supabase URL).
- Migration: `DATABASE_URL_UNPOOLED` (direct/session URL).
- With `pg` 8.23, Supabase pooler URLs using `sslmode=require` also need
  `uselibpqcompat=true`; alternatively configure the trusted CA and use
  `sslmode=verify-full`.
- Accepted aliases: `SHAREDNET_POSTGRES_URL` and
  `SHAREDNET_POSTGRES_URL_NON_POOLING`.
- Apply reviewed migrations with `pnpm db:migrate`.
- Confirm schema source and migration history agree with `pnpm db:generate`;
  it must report no changes.
- Treat the checked Drizzle journal as authoritative. Do not create or alter
  `sharednet_auth` or `sharednet` objects manually in production.
- Applied migration files are immutable. Make every later schema change in the
  TypeScript schema and generate a new migration instead of editing old SQL.

Supabase anon, publishable, service-role, and JWT-secret values are not required
by this V1 server path. High-privilege values must remain server-side and should
never be prefixed with `NEXT_PUBLIC_`.
