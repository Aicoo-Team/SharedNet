# A person's picture is stored, not linked — 2026-09-12

Status: **proposed** on 2026-09-12, for the owner.

The owner's ask, right after Google sign-in landed: 让 google 登录的，自动上传
头像.

## 1. What was already there, and why it is not enough

Better Auth maps Google's `profile.picture` into `user.image`, and the account
button already renders `<img src={account.image}>`. So a picture does appear —
as a hotlink to `lh3.googleusercontent.com`.

Three things are wrong with that, in rising order of seriousness:

- Every page view is a request to Google, carrying whatever the browser sends
  with it.
- The URL rotates when Google decides to rotate it, and the face silently
  becomes a broken image.
- **On a network that cannot reach Google, the person has no face at all.**
  That is not hypothetical: it is the owner's own network, and it is why this
  was asked for.

## 2. What happens now

At sign-up, after the Principal is provisioned, the picture is fetched once,
recognised, stored, and `user.image` is rewritten to `/a/<ava_…>` — this
origin. Nothing at render time leaves the building.

Nothing about it may fail a sign-up. A refusal, a timeout, an oversized file
and a file that is not an image all end the same way: no stored picture, a
working account, one line in the log. It is the same posture Principal
provisioning already takes, for the same reason — a third party having a bad
minute must not cost someone their account.

## 3. Fetching a URL that arrived in somebody else's JSON

The URL comes from an OAuth profile. This server did not write it, so fetching
whatever it names is a request-forgery primitive pointed at our own network:
`http://169.254.169.254/…` is a URL too. Only `https:` and only hosts matching
`*.googleusercontent.com` are fetched. Half a mebibyte, five seconds.

## 4. Serving somebody else's bytes inline

The artifact store refuses to render anything inline, because an HTML file
served from our origin *is* a page on our origin (artifacts decision §3). An
avatar has to render — it is an `<img>` — so this is the one exception, and it
is bounded rather than trusted:

- The bytes are recognised by their own signature before being stored: PNG,
  JPEG, WebP, and nothing else. The `Content-Type` the far end claimed is not
  consulted.
- **SVG is deliberately absent.** It is the one image format that carries
  script.
- The column has a `CHECK` allowing exactly those three, so a row that
  disagreed could not exist.
- The response still carries `nosniff` and `default-src 'none'; sandbox`, so
  even a row that somehow disagreed could not become a page.

The id in the URL is an opaque `ava_…`, not the account's id: a public URL
should not name a person. A new picture gets a new id, so the response is
`immutable` and cached for a year.

## 5. What this does not do yet

- **Only at sign-up.** Someone who already has an account and links Google
  later keeps whatever picture they had. The hook that would cover it fires on
  every profile refresh, and making that idempotent is a second change.
- No upload from the Dashboard, no cropping, no default generated face. The
  account button already falls back to the first letter of the name.
- Avatars still appear only in the account button. A Room draws driver marks,
  which say what is speaking rather than who owns it; whether a person's face
  belongs there is a product question nobody has asked.
