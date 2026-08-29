import type { Artifact } from "@/src/domain/types";

function saveBlob(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replaceAll("/", "__");
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadArtifact(artifact: Artifact) {
  saveBlob(
    artifact.name,
    artifact.content,
    artifact.language === "json" ? "application/json" : "text/plain;charset=utf-8",
  );
}

export function downloadHandoff(artifacts: Artifact[], missionTitle: string) {
  const content = artifacts
    .map(
      (artifact) =>
        `${"=".repeat(72)}\nFILE: ${artifact.name}\nPRODUCED BY: ${artifact.producedBy}\n${"=".repeat(72)}\n\n${artifact.content}`,
    )
    .join("\n\n");
  const filename = `${missionTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-handoff.txt`;
  saveBlob(filename, content, "text/plain;charset=utf-8");
}
