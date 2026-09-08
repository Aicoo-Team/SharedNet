// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { driverMark } from "./driver-mark";

const MARKS_DIR = join(process.cwd(), "public", "drivers");

/**
 * The Room and the homepage both draw marks on a near-white ground
 * (`--sn-paper`). A logo shipped in its white-on-dark variant vanishes there,
 * so every vector mark has to carry at least one ink darker than the paper.
 */
const PAPER_IS_LIGHTER_THAN = 0.6;

const NAMED = new Map([
  ["white", "#ffffff"],
  ["black", "#000000"],
]);

function relativeLuminance(fill: string): number | null {
  const named = NAMED.get(fill.toLowerCase());
  const hex = (named ?? fill).replace("#", "");
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  if (!/^[\da-f]{6}$/i.test(full)) return null;
  const channels = [0, 2, 4].map((at) => {
    const channel = Number.parseInt(full.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function inks(svg: string): number[] {
  return [...svg.matchAll(/fill="([^"]+)"/g)]
    .map((match) => relativeLuminance(match[1]))
    .filter((luminance): luminance is number => luminance !== null);
}

describe("driver marks", () => {
  const vectors = readdirSync(MARKS_DIR).filter((name) => name.endsWith(".svg"));

  it("ships a vector for every mark that claims one", () => {
    expect(vectors).not.toHaveLength(0);
    expect(driverMark("openhands").asset).toBe("/drivers/openhands.svg");
  });

  it.each(vectors)("draws %s in an ink that shows on the paper background", (vector) => {
    const drawn = inks(readFileSync(join(MARKS_DIR, vector), "utf8"));

    expect(drawn).not.toHaveLength(0);
    expect(Math.min(...drawn)).toBeLessThan(PAPER_IS_LIGHTER_THAN);
  });
});
