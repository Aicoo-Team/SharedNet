# Google sign-in — 2026-09-10

This records what was decided about signing in with Google, why, and what was
rejected. It extends `2026-09-04-identity-model.md`, which is unchanged: a
Better Auth account still maps to exactly one Principal, and this adds a
second door into that account rather than a second kind of account.

## 1. A person signs in with a password or with Google; both are the same account

An account is an email address. Google proves the same address a password
proves, so a Google sign-in resolves to the same Better Auth `user`, the same
Principal, and the same Rooms. Nothing downstream learns which door was used:
`provisionPrincipalForUser` already runs on user creation, whichever way the
user row came to exist, so a Google sign-up gets a Principal the same way.

**Rejected: a separate identity for social accounts.** Two Principals for one
person would put their own Instances on opposite sides of every membership
check for no gain.

Google is configured or absent, never half-configured: an id without a secret
is the shape a half-finished environment has, and a button that cannot
complete is worse than no button. The login page asks the same function the
auth config asks, so what is drawn and what works cannot disagree.

## 2. The account row is unique on `(provider_id, account_id)`, in the database

Better Auth declares no such constraint in its generated schema and resolves
an account in application code. The stance until now was to leave uniqueness
to the library. That stance is wrong for more than one provider.

The library does not *prevent* a duplicate; it *detects* one, and it detects
it by refusing to sign anyone in — `Multiple accounts match the same accountId
for provider …` — from which no request can recover. Recovery is manual
surgery on a shared database. With one provider it could not happen: a
credential account's `account_id` is its own user id. A second provider makes
two concurrent callbacks for one Google subject reachable, so the database now
refuses the second row and the request fails instead of the account.

The constraint this replaces was on `(issuer, account_id)`. `issuer` left the
Better Auth account model in 1.7.3 and migration 0012 made the column
nullable, so every row written since carries NULL there; distinct NULLs made
the constraint inert. It read as protection and enforced nothing, which is
worse than absent — the schema comment cited it as the reason no other
constraint was needed.

**Rejected: dropping the `issuer` column in the same migration.** Nothing
writes it and nothing reads it, but production migrates inside its build and
serves the previous code for about a minute afterwards. A column drop in that
window is a contraction with no upside here; the column costs nothing to keep
and can go in its own release.

**Rejected: `requireLocalEmailVerified: false`, to smooth over §3.** See below.

## 3. A preview borrows production's redirect URI

Google refuses a wildcard redirect URI and a Vercel preview's hostname changes
with every deployment, so a preview cannot register one. Better Auth's OAuth
proxy resolves this: the preview sends the person to Google with production as
the redirect, production hands the encrypted profile straight back to the
preview's own callback, and the session is created on the preview. Production
never creates a user or a session for a preview's sign-in.

It is enabled only when `VERCEL_ENV=preview`. On production the two origins
agree and the plugin is already a no-op; on a laptop they do *not* agree, so
leaving it on would route a local sign-in through production. The environment
test is deliberate rather than trusting the plugin's own skip check.

The branch alias (`VERCEL_BRANCH_URL`) joins the deployment hostname in the
trusted origins for the same reason it is needed at all: the proxy replays the
profile to a trusted origin, and the branch alias is the URL a person actually
opens. Both are set by the platform, so both carry the trust `VERCEL_URL`
already had.

**Rejected: previews without Google.** Then the one environment where a
sign-in change is reviewed is the one where it cannot be exercised, and every
auth change would be verified for the first time in production.

## 4. Verification is still not a gate, and that leaves one edge open

Better Auth refuses to link a social identity into an existing local account
whose address is not verified (`requireLocalEmailVerified`, default true): an
attacker who pre-registers an unverified account at a victim's address must
not have the victim's Google identity linked into the attacker-owned row.

SharedNet deliberately does not gate on verification
(`2026-09-06`-era product decision, stated in the README), so accounts with
`email_verified = false` exist in numbers. A person holding one who signs in
with Google is refused with `account_not_linked`.

This release does not resolve that; it makes the refusal legible. The failure
now returns to `/login` with a sentence naming the cause and the two ways out
— sign in with the password, or verify the address first — instead of Better
Auth's default error page.

**Rejected: `requireLocalEmailVerified: false`.** It clears the path and opens
the takeover it exists to prevent, and Better Auth has already deprecated the
option: the gate becomes unconditional in the next minor, so choosing it now
buys a smooth month and a broken upgrade.

**Rejected: `trustedProviders: ["google"]`.** It does not apply. The condition
is a disjunction, and the trusted-provider term only clears
`!isTrustedProvider && !userInfo.emailVerified` — already false, because
Google reports the address as verified. The local-verification term is
independent and still refuses.

The open choice is between making verification a gate for the actions that
lend your identity to someone else (the README already names them: creating a
Room, minting an invite, minting a claim) and offering an explicit "link
Google" action to a signed-in person. Both are out of scope here.
