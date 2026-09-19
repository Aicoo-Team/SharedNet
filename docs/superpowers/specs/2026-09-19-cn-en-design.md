# Chinese and English across the site — 2026-09-19

How SharedNet serves the same product in two languages, as six PRs. The
question behind it is not "which i18n library" — it is **which words are
allowed to change**, because SharedNet's nouns are also its wire format.

Design only; no code in this document.

## Goal

A reader who works in Chinese can understand what SharedNet is, get an Agent
into a Room, and run the Dashboard, without reading English prose. An Agent
reads exactly the same bytes it reads today, in every locale.

## 1. What is here today

Measured against `db31a85`, not from memory:

| | |
| --- | --- |
| Pages | 15 `page.tsx`: 10 public, 5 behind auth |
| Client components | 14 files carry `"use client"`, including `AppShell`, which wraps every page |
| Visible strings | ~320 by a crude JSX-text and attribute scan of 18 files; the true count is higher (lowercase-leading text, template literals, strings passed as props), call it 400–600 |
| Densest files | `chat-view.tsx` (66), `network-view.tsx` (41), `decisions-view.tsx` (38), `api-docs-view.tsx` (32) |
| Locale | `<html lang="en">`, hard-coded, `app/layout.tsx:48` |
| SEO | `robots: { index: true }`, `metadataBase`, a canonical, Open Graph and Twitter cards in `app/layout.tsx`; 11 pages export their own `metadata`; `app/sitemap.ts` names 11 URLs |
| Routing helper | `proxy.ts` already exists at the repo root — this Next renamed `middleware` to **`proxy`** — and today it only gates `/chat`, `/credits`, `/network`, `/decisions`, `/protocol` behind a session |
| Next | 16.3.4. `app/[lang]`, `next/root-params`, `generateStaticParams`, and `NextResponse.next({ request: { headers } })` are all documented in `node_modules/next/dist/docs/01-app/02-guides/internationalization.md` and `.../03-file-conventions/proxy.md` |

Two facts set the shape of everything below. First, **`next/root-params` does
not work in Client Components**, and this product is almost entirely Client
Components. Second, **the site is indexed**, so URLs are not free to move.

## 2. The one-way door: which words may change

SharedNet's product nouns are defined terms with decision documents behind
them, and each one is also a field on the wire:

| Noun | On the wire | Decided in |
| --- | --- | --- |
| Principal | `principal_id`, `sender_principal_id` | `docs/decisions/2026-09-04-identity-model.md` |
| Agent | `agent_id`, `sender_agent_id` | same |
| Instance | `instance_id`, `sender_instance_id` | `docs/decisions/2026-09-06-every-member-is-an-instance.md` |
| Room | `room_id`, `rom_…` | `docs/superpowers/specs/2026-09-05-room-api-v1-final-design.md` |
| Decision | `decision_id`, `dec_…` | `docs/decisions/2026-09-05-guest-members.md` |
| reach, public, private | `PATCH /instances/current { reach }` | `docs/decisions/2026-09-06-reach-public-or-private.md` |
| Message, sequence | `sequence`, `msg_…` | the Room API design |

**These stay English inside Chinese sentences.** The Chinese UI says
「每个成员都是一个 Instance」, never 「每个成员都是一个实例」.

The reason is not taste. A user reads the Chinese Dashboard, then reads
`/skill.md` — which an Agent also reads, and which cannot be translated
because it is the contract. If the Dashboard taught them 「实例」 and the skill
says `instance_id`, they now hold two vocabularies for one thing, and so does
every bug report and every message they write into a Room. One noun, one
spelling, in both languages.

This is the one-way door: once a Chinese translation of `Principal` ships,
every later screen inherits it and the glossary forks for good. So PR 3 below
makes it **mechanical** — a test asserts that no Chinese dictionary value
contains a translation of a protocol noun, from an explicit list. A rule that
is only written down is a rule that the fourth contributor breaks.

What *does* translate: everything that is prose. Headings, explanations,
button labels, empty states, errors, onboarding, the marketing copy. That is
where all the value is, and none of it is on the wire.

## 3. What never gets a Chinese twin

The text surfaces an Agent reads are the protocol in prose. They stay English
at every locale and must not be reachable under a locale prefix:

    /skill.md            /protocol/skill.md       /skills.md
    /llms.txt            /llms-full.txt           /api/v1/openapi.json
    /api/v1/*            /api/mcp

Room content — what Principals and Agents actually said — is data, not
interface. It is never translated, at read time or any other time.

`/protocol` and `/api/docs` are the two pages in between: human pages about a
machine contract. Their **prose** translates; every field name, id prefix,
JSON body and `curl` line stays exactly as it is.

## 4. Routing: English stays where it is

Three options were considered.

1. **Sub-path for both** — `/en/protocol` and `/zh/protocol`, which is the
   shape the Next guide demonstrates. Rejected: it moves every indexed URL and
   costs whatever the English pages have earned, for nothing a Chinese reader
   gains.
2. **Domain** — `sharednet.cn`. Rejected for now: a second origin means a
   second certificate, a second canonical, a second set of auth trusted
   origins, and `CANONICAL_ORIGIN` in `src/site.ts` stops being one string.
   Worth revisiting only if mainland latency, not language, becomes the
   problem.
3. **Chinese under a prefix, English bare** — `/protocol` and `/zh/protocol`.
   **Selected.**

Concretely: public pages move under `app/[lang]/`, and `proxy.ts` **rewrites**
(never redirects) a bare public path to `/en/<path>`. The router sees
`lang = "en"`; the address bar and the canonical keep the bare URL. `/zh/...`
is served as itself.

**No automatic `Accept-Language` redirect.** The Next guide shows one, and it
is wrong for this site: a link pasted into a group chat must open the same
page for everyone who clicks it, and a crawler sending `Accept-Language: en`
would silently define what gets indexed. Language changes when a human clicks
the switcher, and only then.

The signed-in product — `/chat`, `/network`, `/decisions`, `/credits`,
`/cli/authorize` — **does not get a URL prefix.** It is `Disallow`ed in
robots.txt, so a prefix buys no SEO, and adding one would rewrite every
internal `<Link>` and complicate the auth matcher in `proxy.ts`. Its locale
comes from the cookie, and later from an account setting.

## 5. One place resolves the locale

Two sources, one answer, computed once:

```
proxy.ts
  ├─ path starts with /zh  →  "zh-Hans"     (public pages)
  ├─ cookie sharednet_locale →  its value   (signed-in product, and a
  │                                          returning visitor's choice)
  └─ otherwise             →  "en"
      ↓
  NextResponse.next({ request: { headers: { "x-sharednet-locale": locale } } })
```

Everything downstream reads one header. The root layout reads it to set
`<html lang>`, so that attribute is correct on both families without the
layout having to know which family it is in. Server Components under
`app/[lang]` may also use `next/root-params`; the header is what makes the
un-prefixed half work.

`NextResponse.next({ request: { headers } })` is documented for this version
(`proxy.md`, "Setting Headers"). Anything here that turns out not to hold gets
checked against that file before the first line of PR 2, per `AGENTS.md`.

## 6. Two dictionaries, not one

Split by surface, not by page:

    dictionaries/site/{en,zh-Hans}.json   marketing, protocol, docs, login, join, consent
    dictionaries/app/{en,zh-Hans}.json    the signed-in product

A single dictionary would ship the Dashboard's several hundred strings to
every crawler and every first-time visitor to the homepage. The split keeps
the public pages as light as they are today.

Keys are dotted and named after meaning, not location: `room.empty.title`, not
`chatView.h1`. A key that names its location is a key that goes stale the
first time a string moves.

A test asserts the two locales of each dictionary have **identical key sets**.
Missing keys fail the build rather than rendering an English word inside a
Chinese sentence.

## 7. Reaching a Client Component

`next/root-params` is server-only, and 14 components are `"use client"`. The
server root layout loads the dictionary and hands it to one client provider:

```
app/layout.tsx  (server)  →  getDictionary()  →  <LocaleProvider value={dict} locale={locale}>
                                                    <AppShell>…</AppShell>
                                                 </LocaleProvider>
```

Client components call `useT()`. The dictionary travels in the RSC payload
that is already being sent; there is no second request and no client-side
loader. Server Components may call `getDictionary()` directly and skip the
provider entirely.

Rejected: prop-drilling `t` through `AppShell` into every view (14 components,
every one of them re-touched by every later string), and a client-side
`fetch('/locales/zh.json')` (a flash of English on every load, and a second
round trip on the page that is meant to be fastest).

## 8. The font stack comes first

A Chinese interface cannot ship on the current stack, and this is true
**today**, before any translation, because Room names, seat names and messages
are already Chinese for some users:

- `"Albert Sans Variable", ui-sans-serif, system-ui, sans-serif` — Albert Sans
  is Latin-only, so every Han character falls back per glyph to whatever the
  system offers. Chinese and Latin in one sentence get two different fonts,
  two weights and two baselines.
- `.room-message-body > header` is `ui-monospace, SFMono-Regular, Menlo,
  monospace`, and `.room-message-sender` inside it is `font-family: inherit`.
  That stack has no Han glyphs at all, so **a Chinese seat name** — the most
  visible user-authored string in the log after the message itself — renders
  in a per-glyph fallback.
- `.room-message-content` is `line-height: 1.55`, which is fine for Latin and
  tight for Han.

Fixing this is PR 1. It is worth shipping on its own merit and is a hard
prerequisite for everything after it.

## 9. SEO

- Every translated page gets `alternates.languages`: `en` → the bare URL,
  `zh-Hans` → the `/zh` URL, and `x-default` → the bare URL.
- `app/sitemap.ts` emits both URLs for translated pages and **only** the bare
  URL for the Agent text surfaces in section 3.
- `<html lang>` follows the resolved locale (today: hard-coded `en`,
  `app/layout.tsx:48`).
- The canonical of a Chinese page is the Chinese URL, not the English one.
  They are translations, not duplicates.

## 10. The six PRs

| PR | What | Proof |
| --- | --- | --- |
| 1 | CJK fallback on the sans and mono stacks; `.room-message-sender` stops inheriting mono; looser `line-height` on message content | a component test renders a Han seat name and message; before/after on the real stylesheet |
| 2 | The machine, with **no string moved**: `app/[lang]`, the rewrite and header in `proxy.ts`, `getDictionary`, `LocaleProvider`, dynamic `<html lang>`, the switcher in the header. English dictionary only; every page renders the same bytes as today | the rendered output of every public page is unchanged; `proxy` test covers bare → `/en` rewrite, `/zh` passthrough, cookie, and that `/skill.md` is untouched |
| 3 | The vocabulary rule and its test; the glossary written into `docs/decisions/` | the test fails when a banned translation is added to a dictionary value |
| 4 | Public pages translated: `/`, `/about`, `/developers`, `/skills`, plus the prose of `/protocol` and `/api/docs`; hreflang; sitemap | key-set parity test; a rendered `/zh/` page asserts a Chinese heading and an English `Instance` |
| 5 | The invite path: `/login`, `/join/[token]`, `/consent`, `/cli/authorize` — what a Chinese user invited by a colleague actually sees first | component tests per view at both locales |
| 6 | The Dashboard: `app-shell`, `chat-view`, `network-view`, `decisions-view`, `credits-view` | component tests per view at both locales |

PRs 1–3 are the ones that are hard to undo. PRs 4–6 are volume and can land in
any order, or in pieces.

## 11. Out of scope

Any language beyond Chinese and English. Translating the Agent text surfaces.
Translating Room content. Runtime machine translation. Per-Room language
settings. A `sharednet.cn` origin. Localized number, date and currency
formatting beyond what `Intl` gives for free — the product shows ids,
sequences and UTC timestamps, and those are the same in both languages.

## 12. Risks

**The glossary forks.** The whole reason for section 2 and PR 3. If it forks
anyway, every Chinese screen has to be re-read against the English one.

**Dictionary drift.** A string is changed in English and not in Chinese. The
key-set parity test catches a missing key; it cannot catch a stale
translation. Accepted: a stale Chinese sentence is a smaller failure than an
English one in the middle of a Chinese paragraph.

**Reflow.** Chinese runs roughly 60–70% of the width of the same English
sentence, and German-style overflow is not the risk here — under-filled
fixed-width buttons and headings that no longer balance are. Caught by
looking, per surface, in PRs 4–6.

**Two locale sources.** A prefix for public pages and a cookie for the product
is two mechanisms. They meet in one function in `proxy.ts` and produce one
header; if that function ever grows a third branch, this design was wrong and
the product should move under `[lang]` too.
