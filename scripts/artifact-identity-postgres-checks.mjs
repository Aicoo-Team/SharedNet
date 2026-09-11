import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Real SQL regressions for artifacts surviving a guest-to-account claim. */
export async function checkArtifactIdentity({ repository, pool, owner, visitor, account, raceGuest, gate, controlledRepository, waitForDatabaseLock, handleRequest }) {
  const bytes = (value) => new TextEncoder().encode(value);
  const fileInput = (filename, value = "guest file") => ({ filename, reach: "private", room_id: null, content_type: "text/plain", bytes: bytes(value) });
  const upload = (store, token, key, filename, body = "guest file", reach = "private", room = null) => handleRequest(new Request("http://127.0.0.1/api/v1/artifacts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key, "x-sharednet-filename": filename, "x-sharednet-reach": reach, ...(room ? { "x-sharednet-room": room } : {}) },
    body,
  }), store);

  // Rows issued before the fix remain under the old Principal. The existing
  // merge pointer must recover them without a backfill or a changed replay.
  {
    const seat = await raceGuest("artifact-owner");
    const before = await repository.artifactUsage(owner.auth);
    const files = [];
    for (const reach of ["private", "room", "link"]) {
      const key = randomUUID();
      const room = reach === "room" ? seat.membership.room_id : null;
      const response = await upload(repository, seat.member_token, key, `${reach}-claimed.txt`, "guest file", reach, room);
      assert.equal(response.status, 201);
      const body = await response.text();
      files.push({ reach, room, key, body, ...JSON.parse(body) });
    }
    const login = await repository.startCliLogin({ label: "artifact owner", seats: [seat.member_token] });
    await repository.approveCliLogin({ code: login.user_code, principalId: owner.principalId });
    const claimed = await repository.authenticateInstance(seat.member_token);
    assert.equal(claimed.principalId, owner.principalId);
    const usage = await repository.artifactUsage(claimed);
    assert.deepEqual([usage.count, usage.bytes], [before.count + 3, before.bytes + 30], "claimed files count against the account's quota");
    const oldRows = await pool.query("select count(*)::int as count from sharednet.artifact where principal_id = $1", [seat.auth.principalId]);
    assert.equal(oldRows.rows[0].count, 3, "the pre-fix row shape is recovered without rewriting historical ownership");
    const listed = (await repository.listArtifacts(claimed, { room_id: null, before: null, limit: 100 })).items;
    for (const file of files) {
      assert.ok(listed.some((entry) => entry.id === file.artifact.id && entry.principal_id === owner.principalId));
      const read = await repository.readArtifact(claimed, file.artifact.id);
      assert.equal(new TextDecoder().decode(read.bytes), "guest file");
      assert.equal(read.artifact.principal_id, owner.principalId);
      await assert.rejects(repository.deleteArtifact(visitor.auth, file.artifact.id), { code: "artifact_not_found" });
      if (file.reach !== "room") await assert.rejects(repository.readArtifact(visitor.auth, file.artifact.id), { code: "artifact_not_found" });
      if (file.link_key) assert.equal(new TextDecoder().decode((await repository.readArtifactByLink(file.artifact.id, file.link_key)).bytes), "guest file");
      const replay = await upload(repository, seat.member_token, file.key, file.artifact.filename, "guest file", file.reach, file.room);
      assert.equal(replay.status, 201);
      assert.equal(replay.headers.get("idempotency-replayed"), "true");
      assert.equal(await replay.text(), file.body, "claim never rewrites an upload's recorded response");
      const conflict = await upload(repository, seat.member_token, file.key, file.artifact.filename, "changed", file.reach, file.room);
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error.code, "idempotency_conflict");
    }
    assert.equal((await repository.artifactUsage(claimed)).count, before.count + 3, "replay created no second file");
    for (const file of files) {
      assert.equal((await repository.deleteArtifact(claimed, file.artifact.id)).artifact.principal_id, owner.principalId);
      if (file.link_key) await assert.rejects(repository.readArtifactByLink(file.artifact.id, file.link_key), { code: "artifact_not_found" });
    }
    assert.deepEqual(await repository.artifactUsage(claimed), before, "all inherited files can be deleted and free their bytes");
  }

  // Authentication may precede a claim by an arbitrary request-body read.
  // A claim already finished at operation start is resolved to its account.
  {
    const seat = await raceGuest("stale-artifact-auth");
    const login = await repository.startCliLogin({ label: "stale auth", seats: [seat.member_token] });
    await repository.approveCliLogin({ code: login.user_code, principalId: owner.principalId });
    const result = await repository.uploadArtifact(seat.auth, fileInput("stale.txt"));
    assert.equal(result.artifact.principal_id, owner.principalId);
    await repository.deleteArtifact(owner.auth, result.artifact.id);
  }

  // Discovery preceded the claim but locking follows it. Refuse before trying
  // to add the newly discovered account to an already held identity lock set.
  {
    const seat = await raceGuest("moving-artifact-auth");
    const login = await repository.startCliLogin({ label: "moving auth", seats: [seat.member_token] });
    const paused = gate();
    let intercepted = false;
    const uploader = await controlledRepository({ before: async (statement) => {
      if (!intercepted && statement.includes("pg_advisory_xact_lock")) { intercepted = true; await paused.pause(); }
    } });
    const blocker = await controlledRepository();
    try {
      const attempt = uploader.repository.uploadArtifact(seat.auth, fileInput("moving.txt"));
      let completed = false;
      const settled = attempt.then((value) => ({ value }), (error) => ({ error })).then((result) => { completed = true; return result; });
      await paused.arrived;
      await repository.approveCliLogin({ code: login.user_code, principalId: owner.principalId });
      await blocker.client.query("begin");
      await blocker.client.query("select pg_advisory_xact_lock(hashtext($1))", [`credits:${owner.principalId}`]);
      paused.release();
      const blocked = await waitForDatabaseLock(uploader.pid, () => completed);
      await blocker.client.query("rollback");
      const result = await settled;
      assert.equal(blocked, false, "never extend identity locks after an owner moves");
      assert.equal(result.error?.code, "credits_identity_moved");
      const retry = await repository.uploadArtifact(seat.auth, fileInput("moving.txt"));
      assert.equal(retry.artifact.principal_id, owner.principalId);
      await repository.deleteArtifact(owner.auth, retry.artifact.id);
    } finally { paused.release(); await blocker.client.query("rollback"); await uploader.client.end(); await blocker.client.end(); }
  }

  // The upload holds the guest's identity first. The claim must wait for its
  // bytes to commit and then include them in the new account's holdings.
  {
    const seat = await raceGuest("upload-first-artifact");
    const login = await repository.startCliLogin({ label: "upload first", seats: [seat.member_token] });
    const paused = gate();
    let intercepted = false;
    const uploader = await controlledRepository({ after: async (statement, values) => {
      if (!intercepted && statement.includes("pg_advisory_xact_lock") && values[0] === `credits:${seat.auth.principalId}`) {
        intercepted = true; await paused.pause();
      }
    } });
    const claimer = await controlledRepository();
    try {
      const before = await repository.artifactUsage(owner.auth);
      const attempt = uploader.repository.uploadArtifact(seat.auth, fileInput("upload-first.txt"));
      const settledUpload = Promise.allSettled([attempt]);
      await paused.arrived;
      const claim = claimer.repository.approveCliLogin({ code: login.user_code, principalId: owner.principalId });
      const settledClaim = Promise.allSettled([claim]);
      assert.equal(await waitForDatabaseLock(claimer.pid), true);
      paused.release();
      const [uploaded] = await settledUpload;
      const [claimed] = await settledClaim;
      assert.equal(uploaded.status, "fulfilled");
      assert.equal(claimed.status, "fulfilled");
      const usage = await repository.artifactUsage(owner.auth);
      assert.deepEqual([usage.count, usage.bytes], [before.count + 1, before.bytes + 10]);
      assert.equal(new TextDecoder().decode((await repository.readArtifact(owner.auth, uploaded.value.artifact.id)).bytes), "guest file");
      await repository.deleteArtifact(owner.auth, uploaded.value.artifact.id);
    } finally { paused.release(); await uploader.client.end(); await claimer.client.end(); }
  }

  // Quota counts metadata: a near-full size fixture avoids allocating 256 MiB
  // merely to test arithmetic. Actual bytes are separately round-tripped above.
  {
    const holder = await account("artifact-quota");
    const seed = await repository.uploadArtifact(holder.auth, fileInput("quota-fixture.bin", "x"));
    const quota = (await repository.artifactUsage(holder.auth)).quota_bytes;
    const staleSeat = await raceGuest("artifact-quota-alias");
    const login = await repository.startCliLogin({ label: "quota alias", seats: [staleSeat.member_token] });
    await repository.approveCliLogin({ code: login.user_code, principalId: holder.principalId });
    await pool.query("update sharednet.artifact set size_bytes = $1 where id = $2", [quota - 1, seed.artifact.id]);
    const paused = gate();
    let intercepted = false;
    const first = await controlledRepository({ after: async (statement, values) => {
      if (!intercepted && statement.includes("pg_advisory_xact_lock") && values[0] === `artifacts:${holder.principalId}`) {
        intercepted = true; await paused.pause();
      }
    } });
    const second = await controlledRepository();
    try {
      const accepted = first.repository.uploadArtifact(staleSeat.auth, fileInput("last-byte.txt", "x"));
      const settledFirst = Promise.allSettled([accepted]);
      await paused.arrived;
      const refused = second.repository.uploadArtifact(holder.auth, fileInput("one-too-many.txt", "x"));
      const settledSecond = Promise.allSettled([refused]);
      assert.equal(await waitForDatabaseLock(second.pid), true);
      paused.release();
      const [left] = await settledFirst;
      const [right] = await settledSecond;
      assert.equal(left.status, "fulfilled");
      assert.equal(right.status, "rejected");
      assert.equal(right.reason.code, "artifact_quota_reached");
      assert.deepEqual(await repository.artifactUsage(holder.auth), { bytes: quota, count: 2, quota_bytes: quota });
    } finally { paused.release(); await first.client.end(); await second.client.end(); }
  }

  // Claims preserve files even if two valid holdings exceed one quota. Every
  // inherited row still counts and further uploads are refused until deletion.
  {
    const holder = await account("artifact-merged-quota");
    const seat = await raceGuest("artifact-merged-quota-guest");
    const own = await repository.uploadArtifact(holder.auth, fileInput("own-quota-fixture.bin", "x"));
    const inherited = await repository.uploadArtifact(seat.auth, fileInput("inherited-quota-fixture.bin", "x"));
    const quota = (await repository.artifactUsage(holder.auth)).quota_bytes;
    await pool.query("update sharednet.artifact set size_bytes = $1 where id = any($2::text[])", [quota - 1, [own.artifact.id, inherited.artifact.id]]);
    const login = await repository.startCliLogin({ label: "merged quota", seats: [seat.member_token] });
    await repository.approveCliLogin({ code: login.user_code, principalId: holder.principalId });
    assert.equal((await repository.artifactUsage(holder.auth)).bytes, 2 * (quota - 1));
    await assert.rejects(repository.uploadArtifact(holder.auth, fileInput("too-full.txt", "x")), { code: "artifact_quota_reached" });
    await repository.deleteArtifact(holder.auth, inherited.artifact.id);
    await repository.uploadArtifact(holder.auth, fileInput("now-fits.txt", "x"));
    assert.equal((await repository.artifactUsage(holder.auth)).bytes, quota);
  }
}
