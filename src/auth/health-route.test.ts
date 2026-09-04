// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/packages/db/src/client.ts", () => ({ getDatabase: () => database }));

const { GET } = await import("../../app/api/health/route");

describe("readiness endpoint", () => {
  it("reports ok only after a query actually reaches PostgreSQL", async () => {
    database.execute.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const response = await GET();
    const body = await response.json();

    expect(database.execute).toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", database: "reachable" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("answers 503 when the database is unreachable", async () => {
    database.execute.mockRejectedValueOnce(new Error("connection timeout"));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "unavailable",
      database: "unreachable",
    });
  });

  it("never leaks the connection string or credentials in the failure body", async () => {
    database.execute.mockRejectedValueOnce(
      new Error("password authentication failed for postgres://user:hunter2@db:5432"),
    );

    const response = await GET();
    const text = await response.text();

    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("password");
  });
});
