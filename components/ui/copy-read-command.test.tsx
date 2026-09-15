import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CopyReadCommand } from "./copy-read-command";

describe("CopyReadCommand", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("copies the exact visible Agent instruction", async () => {
    const command = "Read https://sharednet.ai/skill.md";
    render(<CopyReadCommand command={command} />);

    expect(screen.getByText(command)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Copied to clipboard.",
    );
  });

  it("offers a retry when clipboard access fails", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    render(
      <CopyReadCommand command="Read https://sharednet.ai/skill.md" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Copy failed");
  });

  it("drops the shell prompt for text that is not a command", () => {
    const { container, rerender } = render(<CopyReadCommand command="sharednet whoami" />);
    expect(container.textContent).toContain("$");

    rerender(<CopyReadCommand command="https://sharednet.ai/api/mcp" lead={null} />);
    expect(container.textContent).not.toContain("$");
    expect(screen.getByText("https://sharednet.ai/api/mcp")).toBeTruthy();
  });
});
