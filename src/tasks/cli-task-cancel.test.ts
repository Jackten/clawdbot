import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelActiveCliTaskRun,
  isActiveCliTaskRun,
  registerActiveCliTaskRun,
  resetActiveCliTaskRunsForTests,
} from "./cli-task-cancel.js";

beforeEach(() => {
  resetActiveCliTaskRunsForTests();
});

describe("active CLI task runs", () => {
  it("remains discoverable until its owner unregisters", async () => {
    const cancel = vi.fn(() => true);
    const unregister = registerActiveCliTaskRun({ runId: "exec:session-1", cancel });

    expect(isActiveCliTaskRun("exec:session-1")).toBe(true);
    await expect(
      cancelActiveCliTaskRun({ runId: "exec:session-1", reason: "Stop it" }),
    ).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledWith("Stop it");

    unregister?.();
    expect(isActiveCliTaskRun("exec:session-1")).toBe(false);
  });
});
