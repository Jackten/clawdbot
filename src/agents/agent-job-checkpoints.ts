// Durable progress markers for agent-owned background jobs.
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

type AgentJobCheckpointDatabase = Pick<OpenClawStateDatabase, "agent_job_checkpoints">;

export function writeAgentJobCheckpoint(
  params: {
    jobId: string;
    checkpointKey: string;
    itemKey: string;
    result?: unknown;
    completedAt?: number;
  },
  databaseOptions: OpenClawStateDatabaseOptions = {},
): void {
  const completedAt = params.completedAt ?? Date.now();
  const resultJson = params.result === undefined ? null : JSON.stringify(params.result);
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<AgentJobCheckpointDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("agent_job_checkpoints")
        .values({
          job_id: params.jobId,
          checkpoint_key: params.checkpointKey,
          item_key: params.itemKey,
          result_json: resultJson,
          completed_at: completedAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["job_id", "checkpoint_key", "item_key"]).doUpdateSet({
            result_json: resultJson,
            completed_at: completedAt,
          }),
        ),
    );
  }, databaseOptions);
}
