import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { writeAgentJobCheckpoint } from "./agent-job-checkpoints.js";

let stateDir: string | undefined;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  }
});

describe("agent job checkpoints", () => {
  it("persists and advances a background work checkpoint", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-job-checkpoint-"));
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    writeAgentJobCheckpoint(
      {
        jobId: "task-1",
        checkpointKey: "exec.background",
        itemKey: "session-1",
        result: { status: "running" },
        completedAt: 100,
      },
      options,
    );
    writeAgentJobCheckpoint(
      {
        jobId: "task-1",
        checkpointKey: "exec.background",
        itemKey: "session-1",
        result: { status: "succeeded" },
        completedAt: 200,
      },
      options,
    );

    const { db } = openOpenClawStateDatabase(options);
    expect(
      db
        .prepare(
          "SELECT job_id, checkpoint_key, item_key, result_json, completed_at FROM agent_job_checkpoints",
        )
        .get(),
    ).toEqual({
      job_id: "task-1",
      checkpoint_key: "exec.background",
      item_key: "session-1",
      result_json: '{"status":"succeeded"}',
      completed_at: 200,
    });
  });
});
