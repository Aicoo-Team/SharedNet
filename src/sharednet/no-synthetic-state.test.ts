import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["app", "src", "components", "lib"];
const SOURCE_EXTENSIONS = new Set([".css", ".ts", ".tsx"]);
const THIS_TEST = "src/sharednet/no-synthetic-state.test.ts";
const FORBIDDEN_TOKENS = [
  ["sharednet:", "network-console:v3"],
  ["SharedNet", "DemoProvider"],
  ["useSharedNet", "Demo"],
  ["submitChat", "Prompt"],
  ["network", "-demo"],
].map((parts) => parts.join(""));

function shippedSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (path.includes(" 2.")) {
      return [];
    }

    if (entry.isDirectory()) {
      return shippedSourceFiles(path);
    }

    const extension = path.slice(path.lastIndexOf("."));
    return SOURCE_EXTENSIONS.has(extension) ? [path] : [];
  });
}

describe("shipped SharedNet sources", () => {
  it("exclude synthetic orchestration state", () => {
    const violations = SOURCE_ROOTS.flatMap(shippedSourceFiles).flatMap((path) => {
      const sourcePath = relative(process.cwd(), path);

      if (sourcePath === THIS_TEST) {
        return [];
      }

      const source = readFileSync(path, "utf8");
      return FORBIDDEN_TOKENS.filter((token) => source.includes(token)).map(
        (token) => `${sourcePath}: ${token}`,
      );
    });

    expect(violations).toEqual([]);
  });
});
