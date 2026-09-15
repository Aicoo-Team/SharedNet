# Artifact ownership follows a guest claim — 2026-09-11

Status: implemented as the correction to the same-day artifact release.

## The failure

An anonymous Instance can upload before its human signs in. Claiming that
Instance changes its Principal. Artifacts record the uploading Principal
separately, and their Instance foreign key references only the Instance id;
that key does not move artifact ownership when the Instance is claimed.

The result was a private file its uploader could no longer read and a public
link the uploader could no longer stop by deleting its file. All three reaches
also disappeared from the account's quota. The files and their bytes were
still present under a retired Principal. This affects claims completed before
this correction as well as new claims.

## Ownership is derived from the permanent merge mapping

An artifact's effective owner is its stored Principal's
`merged_into_principal_id`, or its stored Principal if never claimed. Guest
Principals can merge only into account Principals, which cannot themselves be
claimed, so this mapping has one hop. The memory repository uses the same
mapping it already maintains for claims.

Authenticated reads, listing, deletion and usage use the effective owner.
Their artifact projections identify that account; the uploading Instance,
filename, digest, bytes and reach remain unchanged. Room membership continues
to grant Room-reach reads, and only the effective owner may delete. A link key
continues opening its existing file until the owner deletes it.

The permanent mapping also recovers rows left by the original release without
backfilling, copying bytes or waiting for a second claim. New uploads write the
current effective Principal. The alternative of moving only future claims'
artifact rows was rejected because it leaves already-retired rows stranded.
Rewriting every historical row or stored response is unnecessary.

## Claims and uploads agree on locking

Upload discovers the original and effective Principal, acquires their complete
set of existing identity advisory locks in sorted order, then resolves the
owner again before authorization or quota checks. Claim already acquires those
same identity locks. An upload that holds them first commits before a claim;
a claim that finishes first is reflected in the upload's owner and quota.

If ownership changes between discovery and locking to an account outside that
set, the upload returns the existing `409 credits_identity_moved` error. The
error's message describes the account changing and asks for a retry. This code
is shared with credits because the conflict is the same account-identity
transition. Nothing is inserted and no idempotency result is saved. A retry can
use the same key. Taking an additional identity lock after discovery was
rejected because it breaks the global order of multi-seat claims.

After identity locks, upload holds the effective account's artifact quota lock
and sums rows stored under both that account and every retired guest it owns.
Concurrent uploads using a stale guest authentication and the account's own
credential therefore contend for the same remaining bytes.

## Claims preserve files; quota restricts new uploads

A claim does not discard files or refuse account login because two valid sets
of files together exceed the account's 256 MiB quota. All inherited bytes still
count. New uploads are refused with `artifact_quota_reached` until the owner
frees enough space by deleting files. Failing a claim or dropping files to fit
a cap would break ownership recovery to enforce an upload limit.

## Retries preserve the original response

Instance upload idempotency uses its stable Instance namespace, already shared
with other mutations. A same-key, same-body upload after claim returns the
original status and body byte-for-byte, including historical ownership in that
response and the original link when applicable. A changed body returns
`idempotency_conflict`. Fresh reads show effective ownership; a retry never
creates a second file or changes its old response.

## Evidence

Handler tests cover all three reaches, outsider refusals, deletion, usage,
claim-stable upload replay, conflicting reuse and authentication captured before
a completed claim. The PostgreSQL Dashboard harness runs
`artifact-identity-postgres-checks.mjs` against its disposable migrated database.
It preserves pre-fix row shapes and exercises both ordered upload/claim
interleavings using real SQL gates, a changed-owner refusal before extra locks,
one last quota byte contested by stale-guest and account uploads, and a claim
whose combined holdings exceed quota. Near-quota tests increase metadata sizes
in isolated fixtures rather than allocate 256 MiB; separate cases verify actual
bytes and digests round-trip and disappear on deletion. No shared database is
used and no migration is required.
