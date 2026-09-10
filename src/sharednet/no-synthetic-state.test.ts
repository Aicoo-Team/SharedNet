import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["app", "src", "components", "lib"];
const SOURCE_EXTENSIONS = new Set([".css", ".ts", ".tsx"]);
const THIS_TEST = "src/sharednet/no-synthetic-state.test.ts";
const PROTECTED_SOURCE_COPIES = new Set<string>([]);
const FORBIDDEN_TOKENS = [
  ["sharednet:", "network-console:v3"],
  ["SharedNet", "DemoProvider"],
  ["useSharedNet", "Demo"],
  ["submitChat", "Prompt"],
  ["network", "-demo"],
].map((parts) => parts.join(""));

function normalizedSourcePath(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}

function shippedSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (PROTECTED_SOURCE_COPIES.has(normalizedSourcePath(path))) {
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
  it("inspects an unrelated source path containing the protected-copy marker", () => {
    const directory = mkdtempSync(join(tmpdir(), "sharednet-source-guard-"));
    const sourcePath = join(directory, "future 2.ts");

    try {
      writeFileSync(sourcePath, "export {};\n");

      expect(shippedSourceFiles(directory)).toEqual([sourcePath]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("exclude synthetic orchestration state", () => {
    const violations = SOURCE_ROOTS.flatMap(shippedSourceFiles).flatMap((path) => {
      const sourcePath = normalizedSourcePath(path);

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
