// @vitest-environment node

import { describe, expect, it } from "vitest";

import { MemorySharedNetRepository } from "./memory-repository.ts";
import { RepositoryError } from "./repository.ts";
import { createRuntimeRepository } from "./runtime-repository.ts";

describe("runtime repository selection", () => {
  it("fails closed when a hosted database is not configured", () => {
    expect(() =>
      createRuntimeRepository({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryError>>({
        code: "service_unavailable",
        status: 503,
      }),
    );
  });

  it("allows the memory repository only for an explicit test server", () => {
    const repository = createRuntimeRepository({
      NODE_ENV: "test",
      SHAREDNET_DEV_API_KEY: `snk_${"a".repeat(43)}`,
    } as NodeJS.ProcessEnv);

    expect(repository).toBeInstanceOf(MemorySharedNetRepository);
  });
});
