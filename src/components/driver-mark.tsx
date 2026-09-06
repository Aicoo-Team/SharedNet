import { siClaude, siCursor, siGithubcopilot, siGooglegemini, siOpencode } from "simple-icons";

/**
 * One mark per coding-Agent driver, keyed by the runtime kind the CLI reports.
 * Marks come from simple-icons (CC0) where the brand is in that set, from a
 * vector under public/drivers (see its NOTICE) for Codex and OpenHands, and
 * from the driver's initials where no permissively licensed mark exists yet.
 */

type Mark = { label: string; hex: string; path?: string; asset?: string; initials: string };

const MARKS: Record<string, Mark> = {
  "claude-code": { label: "Claude Code", hex: siClaude.hex, path: siClaude.path, initials: "CC" },
  codex: { label: "Codex", hex: "000000", asset: "/drivers/codex.svg", initials: "CX" },
  openhands: { label: "OpenHands", hex: "C9A227", asset: "/drivers/openhands.svg", initials: "OH" },
  opencode: { label: "OpenCode", hex: siOpencode.hex, path: siOpencode.path, initials: "OC" },
  "gemini-cli": { label: "Gemini CLI", hex: siGooglegemini.hex, path: siGooglegemini.path, initials: "GM" },
  cursor: { label: "Cursor", hex: siCursor.hex, path: siCursor.path, initials: "CU" },
  "github-copilot": { label: "GitHub Copilot", hex: siGithubcopilot.hex, path: siGithubcopilot.path, initials: "CP" },
  workbuddy: { label: "WorkBuddy", hex: "0052D9", initials: "WB" },
  openclaw: { label: "OpenClaw", hex: "D2312D", asset: "/drivers/openclaw.png", initials: "OC" },
};

/** The drivers the homepage shows, in this order; the owner's pick. */
export const SUPPORTED_DRIVERS = ["claude-code", "openclaw", "codex", "workbuddy", "openhands", "cursor"] as const;

export function driverMark(kind: string): Mark & { known: boolean } {
  const mark = MARKS[kind];
  if (mark) return { ...mark, known: true };
  if (kind === "custom") return { label: "Unknown driver", hex: "6B7A90", initials: "?", known: false };
  return { label: kind, hex: "6B7A90", initials: kind.slice(0, 2).toUpperCase(), known: false };
}

export function DriverMark({ kind, size = 18 }: Readonly<{ kind: string; size?: number }>) {
  const mark = driverMark(kind);
  if (mark.asset) {
    return <img alt="" className="driver-mark" height={size} src={mark.asset} width={size} />;
  }
  if (mark.path) {
    return (
      <svg
        aria-hidden="true"
        className="driver-mark"
        fill={`#${mark.hex === "000000" ? "002147" : mark.hex}`}
        height={size}
        role="img"
        viewBox="0 0 24 24"
        width={size}
      >
        <path d={mark.path} />
      </svg>
    );
  }
  return (
    <span aria-hidden="true" className="driver-mark driver-mark-initials" style={{ color: `#${mark.hex}` }}>
      {mark.initials}
    </span>
  );
}
