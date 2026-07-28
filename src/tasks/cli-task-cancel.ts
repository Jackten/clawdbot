// Process-local cancellation handles for live CLI-owned task runs.

type CliTaskCancelHandle = {
  cancel: (reason: string) => boolean | Promise<boolean>;
};

const activeCliTaskRunsByRunId = new Map<string, CliTaskCancelHandle>();

export function registerActiveCliTaskRun(params: {
  runId: string | undefined;
  cancel: CliTaskCancelHandle["cancel"];
}): (() => void) | undefined {
  const runId = params.runId?.trim();
  if (!runId) {
    return undefined;
  }
  activeCliTaskRunsByRunId.set(runId, {
    cancel: params.cancel,
  });
  return () => {
    if (activeCliTaskRunsByRunId.get(runId)?.cancel === params.cancel) {
      activeCliTaskRunsByRunId.delete(runId);
    }
  };
}

export async function cancelActiveCliTaskRun(params: {
  runId: string | undefined;
  reason?: string;
}): Promise<boolean> {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const handle = activeCliTaskRunsByRunId.get(runId);
  if (!handle) {
    return false;
  }
  return await handle.cancel(params.reason?.trim() || "Cancelled by operator.");
}

export function resetActiveCliTaskRunsForTests(): void {
  activeCliTaskRunsByRunId.clear();
}
