import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SharedNetDemoProvider } from "@/src/context/sharednet-demo-context";
import { ChatView } from "./chat-view";

function renderChat() {
  return render(
    <SharedNetDemoProvider>
      <ChatView />
    </SharedNetDemoProvider>,
  );
}

describe("SharedNet Chat", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the Rooms sidebar visible beside the empty typing surface", () => {
    renderChat();

    const rooms = screen.getByRole("navigation", { name: "Rooms" });
    expect(screen.getByLabelText("What do you want done?")).toBeTruthy();
    expect(screen.getByPlaceholderText("Type here…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send task" })).toBeTruthy();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(within(rooms).getByText("No rooms yet")).toBeTruthy();
    expect(within(rooms).queryByRole("button")).toBeNull();
    expect(screen.queryByText("Active task")).toBeNull();
  });

  it("turns a submitted outcome into a Room and assembles its Agents first", () => {
    renderChat();
    fireEvent.change(screen.getByLabelText("What do you want done?"), {
      target: {
        value: "Build and launch a customer feedback website with Neon and Vercel.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    const rooms = screen.getByRole("navigation", { name: "Rooms" });
    expect(
      within(rooms).getByRole("button", {
        name: "Open room 01: Build and launch a customer feedback website with Neon and Vercel.",
      }),
    ).toHaveAttribute("aria-current", "true");

    const assembly = screen.getByRole("region", {
      name: "Agents assembled for this room",
    });
    expect(within(assembly).getByText("@xisen/planner")).toBeTruthy();
    expect(within(assembly).getByText("@xisen/codex")).toBeTruthy();
    expect(within(assembly).getByText("@aicoo/web-builder")).toBeTruthy();
    expect(within(assembly).getByText("@aicoo/quality")).toBeTruthy();
    expect(screen.getByText("9 Agents assembled · 2 Principals")).toBeTruthy();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("keeps every submitted outcome as a selectable past Room", () => {
    renderChat();
    fireEvent.change(screen.getByLabelText("What do you want done?"), {
      target: { value: "Build the API first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));
    fireEvent.change(screen.getByLabelText("What do you want done?"), {
      target: { value: "Prepare launch verification" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));

    const rooms = screen.getByRole("navigation", { name: "Rooms" });
    expect(within(rooms).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(
      within(rooms).getByRole("button", {
        name: "Open room 01: Build the API first",
      }),
    );

    expect(screen.getByRole("heading", { name: "Build the API first" })).toBeTruthy();
    expect(
      within(rooms).getByRole("button", {
        name: "Open room 01: Build the API first",
      }),
    ).toHaveAttribute("aria-current", "true");
  });
});
