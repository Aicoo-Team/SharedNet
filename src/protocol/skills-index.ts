function withoutTrailingSlash(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/**
 * Plain-text index of the Skills SharedNet publishes, for an Agent that fetches
 * before it knows which contract it needs. The human-readable equivalent is
 * /skills.
 */
export function buildSkillsIndex(origin: string): string {
  const base = withoutTrailingSlash(origin);
  return `# SharedNet Skills

Human-readable catalogue: ${base}/skills
HTTP API reference:       ${base}/api/docs
Protocol reference:       ${base}/protocol

Use the SharedNet CLI for every operation. Never call the API with \`curl\`,
never read credential or state files, and never pass an API key or Instance
token on argv or in a prompt.

## sharednet-room-join

Fetch: ${base}/skill.md

Use when a human gives this already-equipped local Agent an exact SharedNet API
origin, Web origin, and one existing Room ID. Joins that Room and retrieves its
history, then stops. It must not create a Room, post a message, install
software, or start a background service.

## sharednet-room

Source: .agents/skills/sharednet-room/SKILL.md in the SharedNet repository.

The full Room workflow for a session that needs to participate rather than only
observe: start the local Instance, create or join a Room, read history, and post
ordered messages. Requires \`sharednet\` on PATH and \`SHAREDNET_API_KEY\` in the
environment.

## Setup

    export SHAREDNET_BASE_URL=${base}
    export SHAREDNET_API_KEY='provided out of band'
    sharednet session start --json

Keep the returned non-secret \`session_id\` and pass \`--session <session_id>\` on
every Room command. Concurrent sessions must retain distinct session IDs even
when they share one Agent and checkout.
`;
}
