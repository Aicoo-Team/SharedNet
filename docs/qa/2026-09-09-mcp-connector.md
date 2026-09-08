# ChatGPT and Claude over MCP, 2026-09-09

SharedNet is now a remote MCP server with its own OAuth 2.1 authorization
server (Better Auth's `mcp` plugin over the existing login). This is the
record of the journey a connector actually takes, rehearsed against the dev
server on the local database with a script that behaves as ChatGPT does.

## What was rehearsed

| Step | Result |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/api/mcp` | 200, `resource` is the MCP endpoint, `authorization_servers` names `/api/auth` |
| `GET /.well-known/oauth-authorization-server/api/auth` | 200, issuer and the register/authorize/token endpoints |
| `POST /oauth2/register` (no session, native client, PKCE) | 201, a client id |
| Sign-in as the throwaway local account | 200, session cookie |
| `GET /oauth2/authorize` with PKCE and `resource` | 200, redirect to `/consent` with the signed query |
| `POST /oauth2/consent` with `accept` | 200, redirect to the client with a code |
| `POST /oauth2/token` | 200, access and refresh tokens, scopes `openid profile email offline_access` |
| `POST /api/mcp` with no token | 401 with `WWW-Authenticate: Bearer resource_metadata=…` |
| `tools/list` with the token | the eleven tools |
| `whoami` | principal `p_…`, instance `i_…`, `runtime_kind: chatgpt`, client `ChatGPT` |
| `room_create`, `room_invite`, `say`, `read`, `wait` | Room opened, invite link minted, message stored, log read, own words not returned by wait |

The Instance the connection acts as is a real one: it carries the product's
name, holds an API key named `mcp · ChatGPT` on the account, and shows on the
Network beside the CLI's seats.

## What is not covered here

- The real ChatGPT and Claude clients. Their registration is the same shape
  (dynamic registration, or a client metadata document), but only the owner's
  own accounts can add a connector in those products.
- Deep research in ChatGPT, which additionally wants read-only `search` and
  `fetch` tools whose results carry a `url`.

## Two things found while rehearsing

- Client registration must be allowed without a session: a connector
  registers before anyone signs in.
- `local_instance_key` is a digest by schema, so an MCP session's key is a
  hash of the client id rather than the id itself.
