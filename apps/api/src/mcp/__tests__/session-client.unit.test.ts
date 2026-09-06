// SPDX-License-Identifier: BUSL-1.1
/**
 * What the client said at `initialize`, read from the JSON-RPC body and
 * kept beside the session. Pure: no server, no transport.
 */
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import {
  clientInfoFromInitializeBody,
  connectedViaLabel,
  rememberSessionClient,
  sessionClientOf,
} from "../session-client.js";
import { carrySessionIdentity, rememberSessionIdentity } from "../session-identity.js";

const initialize = (params: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params,
});

const session = (): TrustedSessionContext => ({
  tenantId: "33333333-3333-4333-8333-333333333333",
  userId: "22222222-2222-4222-8222-222222222222",
  roles: ["org_employee"],
  groups: [],
  scope: "tenant",
  credential: "bearer",
});

describe("clientInfoFromInitializeBody", () => {
  it("reads name, version and the declared capability names", () => {
    const client = clientInfoFromInitializeBody(
      initialize({
        protocolVersion: "2025-06-18",
        clientInfo: { name: "Claude Desktop", version: "1.2.3" },
        capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
      }),
    );
    expect(client).toEqual({
      name: "Claude Desktop",
      version: "1.2.3",
      capabilities: ["elicitation", "roots", "sampling"],
    });
  });

  it("finds the initialize inside a batch and copes with a missing version", () => {
    const client = clientInfoFromInitializeBody([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      initialize({ clientInfo: { name: "codex" }, capabilities: {} }),
    ]);
    expect(client).toEqual({ name: "codex", version: null, capabilities: [] });
  });

  it("is null for a body without initialize, and for a nameless client", () => {
    expect(clientInfoFromInitializeBody({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toBeNull();
    expect(clientInfoFromInitializeBody(initialize({ capabilities: {} }))).toBeNull();
    expect(clientInfoFromInitializeBody(initialize({ clientInfo: { name: "  " } }))).toBeNull();
    expect(clientInfoFromInitializeBody(null)).toBeNull();
    expect(clientInfoFromInitializeBody("initialize")).toBeNull();
  });
});

describe("rememberSessionClient / sessionClientOf", () => {
  it("keeps the client on the session it was read for, and nowhere else", () => {
    const opened = session();
    const other = session();
    rememberSessionClient(opened, { name: "Claude Code", version: "2.0.0", capabilities: [] });
    expect(sessionClientOf(opened)?.name).toBe("Claude Code");
    expect(sessionClientOf(other)).toBeNull();
  });

  it("does not forget the client when a later request carries no initialize", () => {
    const opened = session();
    rememberSessionClient(opened, { name: "Claude Code", version: null, capabilities: [] });
    rememberSessionClient(opened, null);
    expect(sessionClientOf(opened)?.name).toBe("Claude Code");
  });

  it("survives the per-request identity refresh of a stateful session", () => {
    const captured = session();
    const later = session();
    rememberSessionClient(captured, { name: "Claude Desktop", version: "1.2.3", capabilities: [] });
    rememberSessionIdentity(later, new Headers(), null);
    carrySessionIdentity(captured, later);
    expect(sessionClientOf(captured)).toEqual({
      name: "Claude Desktop",
      version: "1.2.3",
      capabilities: [],
    });
  });
});

describe("connectedViaLabel", () => {
  it("joins name and version, and leaves the name alone without one", () => {
    expect(connectedViaLabel({ name: "Claude Desktop", version: "1.2.3", capabilities: [] })).toBe(
      "Claude Desktop 1.2.3",
    );
    expect(connectedViaLabel({ name: "claude-desktop", version: null, capabilities: [] })).toBe(
      "claude-desktop",
    );
    expect(connectedViaLabel(null)).toBeNull();
  });
});
