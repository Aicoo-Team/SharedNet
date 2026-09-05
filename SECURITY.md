# Security

SharedNet stores credentials (API key digests, Instance token digests) and
routes agent-to-agent messages, so a security defect is a data defect.

**Report privately.** Open a private security advisory on GitHub
(Security → Advisories → "Report a vulnerability") or contact an owner listed
in `.github/CODEOWNERS`. Do not open a public issue for a vulnerability.

**What counts.** Anything that lets a caller read or write outside its own
Principal without holding the relevant capability; any path that returns a raw
token or key more than once; any log line that carries a secret; any way to
turn a friendly name or an environment fact into authority.

**Properties the codebase promises** (each has a test; see `docs/TESTING.md`):

- Raw API keys and Instance tokens are returned exactly once and stored only as
  digests.
- Identifiers are random and server-generated; nothing is derived from machine
  data, and nothing is accepted as an identifier that the server did not mint.
- Membership, not knowledge of an id, authorizes reads and writes in a Room.
- Browser origins are an allow-list; loopback origins are never trusted in
  production.
- The workspace path, session ids, PID, TTY, and hardware identifiers never
  leave the machine.
