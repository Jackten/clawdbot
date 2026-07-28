import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  claimOwnedTalkClientSession,
  rememberTalkClientSession,
  resetTalkClientSessionRegistryForTest,
} from "./talk-client-session-registry.js";

afterEach(() => {
  resetTalkClientSessionRegistryForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("Talk client session registry", () => {
  it("binds a prefetched browser session to its first session key", () => {
    rememberTalkClientSession({ connId: "conn-1", nowMs: 1 });

    expect(
      claimOwnedTalkClientSession({
        connId: "conn-1",
        sessionKey: "agent:main:main",
        nowMs: 2,
      }),
    ).toBe(true);
    expect(
      claimOwnedTalkClientSession({
        connId: "conn-1",
        sessionKey: "agent:other:main",
        nowMs: 3,
      }),
    ).toBe(false);
  });

  it("does not transfer ownership between gateway connections", () => {
    rememberTalkClientSession({
      connId: "conn-1",
      sessionKey: "agent:main:main",
      nowMs: 1,
    });

    expect(
      claimOwnedTalkClientSession({
        connId: "conn-2",
        sessionKey: "agent:main:main",
        nowMs: 2,
      }),
    ).toBe(false);
  });

  it("preserves signed-device ownership across reconnects and database reopen", () => {
    rememberTalkClientSession({
      connId: "conn-1",
      deviceId: "device-owner",
      sessionKey: "agent:main:main",
      nowMs: 1,
    });
    closeOpenClawStateDatabaseForTest();

    expect(
      claimOwnedTalkClientSession({
        connId: "conn-2",
        deviceId: "device-owner",
        sessionKey: "agent:main:main",
        nowMs: 2,
      }),
    ).toBe(true);
  });

  it("does not transfer ownership to a different signed device", () => {
    rememberTalkClientSession({
      connId: "conn-1",
      deviceId: "device-owner",
      sessionKey: "agent:main:main",
      nowMs: 1,
    });

    expect(
      claimOwnedTalkClientSession({
        connId: "conn-2",
        deviceId: "device-foreign",
        sessionKey: "agent:main:main",
        nowMs: 2,
      }),
    ).toBe(false);
  });

  it("expires idle browser session ownership", () => {
    rememberTalkClientSession({
      connId: "conn-1",
      sessionKey: "agent:main:main",
      nowMs: 0,
    });

    expect(
      claimOwnedTalkClientSession({
        connId: "conn-1",
        sessionKey: "agent:main:main",
        nowMs: 30 * 60_000,
      }),
    ).toBe(false);
  });
});
