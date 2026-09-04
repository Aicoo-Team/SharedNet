import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { V1ApiConsole } from "./v1-api-console";

describe("V1 API console", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lets a signed-in account issue a protocol-compatible key into tab memory", async () => {
    const key = `snk_${"A".repeat(43)}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/v1") {
        return Response.json({ capabilities: ["instances", "rooms", "messages"] });
      }
      if (path === "/api/auth/api-key/create") {
        return Response.json({ id: `key_${"0".repeat(10)}`, key });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<V1ApiConsole />);
    fireEvent.click(
      screen.getByRole("button", { name: "Create account API key" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("API key")).toHaveValue(key);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "New API key created and loaded for this tab.",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/api-key/create",
      expect.objectContaining({ credentials: "same-origin", method: "POST" }),
    );
    expect(screen.getByRole("button", { name: "Revoke created key" })).toBeEnabled();
  });

  it("revokes the key created in this tab and clears it from memory", async () => {
    const id = `key_${"1".repeat(10)}`;
    const key = `snk_${"B".repeat(43)}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/v1") return Response.json({ capabilities: [] });
      if (path === "/api/auth/api-key/create") return Response.json({ id, key });
      if (path === "/api/auth/api-key/delete") return Response.json({ success: true });
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<V1ApiConsole />);
    fireEvent.click(screen.getByRole("button", { name: "Create account API key" }));
    await screen.findByRole("button", { name: "Revoke created key" });
    fireEvent.click(screen.getByRole("button", { name: "Revoke created key" }));

    await waitFor(() => expect(screen.getByLabelText("API key")).toHaveValue(""));
    expect(screen.getByRole("status")).toHaveTextContent(
      "The API key created in this tab was revoked.",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/api-key/delete",
      expect.objectContaining({
        body: JSON.stringify({ keyId: id }),
        credentials: "same-origin",
        method: "POST",
      }),
    );
  });

  it("does not erase a separately pasted key when revoking the generated key", async () => {
    const id = `key_${"2".repeat(10)}`;
    const generatedKey = `snk_${"F".repeat(43)}`;
    const pastedKey = `snk_${"G".repeat(43)}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/v1") return Response.json({ capabilities: [] });
      if (path === "/api/auth/api-key/create") {
        return Response.json({ id, key: generatedKey });
      }
      if (path === "/api/auth/api-key/delete") return Response.json({ success: true });
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<V1ApiConsole />);
    fireEvent.click(screen.getByRole("button", { name: "Create account API key" }));
    const keyInput = await screen.findByLabelText("API key");
    await waitFor(() => expect(keyInput).toHaveValue(generatedKey));
    fireEvent.change(keyInput, { target: { value: pastedKey } });
    fireEvent.click(screen.getByRole("button", { name: "Revoke created key" }));

    await waitFor(() => expect(keyInput).toHaveValue(pastedKey));
    expect(screen.queryByRole("button", { name: "Revoke created key" })).not.toBeInTheDocument();
  });

  it("clears Agent, Instance, and Room state when the API key changes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/v1") return Response.json({ capabilities: [] });
      if (path === "/api/v1/agents/default") {
        return Response.json({ agent: { id: "agt_example" } });
      }
      if (path === "/api/v1/agents/agt_example/instances") {
        return Response.json({
          instance: {
            agent_id: "agt_example",
            id: "ins_example",
            principal_id: "pri_example",
          },
          token: `sni_${"C".repeat(43)}`,
        });
      }
      if (path === "/api/v1/rooms") {
        return Response.json({ room: { id: "rom_example", name: "Local Codex room" } });
      }
      return Response.json({ message: "unexpected request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<V1ApiConsole />);
    const keyInput = screen.getByLabelText("API key");
    fireEvent.change(keyInput, { target: { value: `snk_${"D".repeat(43)}` } });
    fireEvent.click(screen.getByRole("button", { name: "Ensure default Agent" }));
    expect(await screen.findByText(/agent_id: agt_example/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start Instance" }));
    expect(await screen.findByText(/instance_id: ins_example/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    expect(await screen.findByText(/room_id: rom_example/)).toBeVisible();

    fireEvent.change(keyInput, { target: { value: `snk_${"E".repeat(43)}` } });

    expect(screen.queryByText(/agent_id: agt_example/)).not.toBeInTheDocument();
    expect(screen.queryByText(/instance_id: ins_example/)).not.toBeInTheDocument();
    expect(screen.queryByText(/room_id: rom_example/)).not.toBeInTheDocument();
  });
});
