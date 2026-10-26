import type { BacklogMetrics, BacklogSource, QueueDepth } from "@waybill/shared";

export const BACKLOG_SAMPLE_INTERVAL_MS = 30_000;
export const BACKLOG_SAMPLE_TIMEOUT_MS = 5000;

type SamplerOptions = {
  metrics: BacklogMetrics;
  readOutbox: (signal: AbortSignal) => Promise<number>;
  readQueue: (signal: AbortSignal) => Promise<QueueDepth>;
  onError: (source: BacklogSource, error: unknown) => void;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
};

export function startBacklogSampler(options: SamplerOptions) {
  const intervalMs = options.intervalMs ?? BACKLOG_SAMPLE_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? BACKLOG_SAMPLE_TIMEOUT_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Backlog sampling intervals and deadlines must be positive finite numbers");
  }
  const now = options.now ?? Date.now;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  let stopped = false;

  function run<T>(source: BacklogSource, read: (signal: AbortSignal) => Promise<T>, record: (value: T, at: number) => void) {
    if (stopped) return;
    const controller = new AbortController();
    controllers.add(controller);
    let failed = false;
    function failure(error: unknown) {
      if (stopped || failed) return;
      failed = true;
      options.metrics.recordFailure(source);
      options.onError(source, error);
    }
    const deadline = setTimeout(() => {
      const error = new Error(`Backlog ${source} sample exceeded ${timeoutMs}ms`);
      controller.abort(error);
      failure(error);
    }, timeoutMs);
    deadline.unref();
    timers.add(deadline);
    const task = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return read(controller.signal);
    }).then(value => {
      if (!stopped && !controller.signal.aborted) record(value, now() / 1000);
    }).catch(failure).finally(() => {
      clearTimeout(deadline);
      timers.delete(deadline);
      controllers.delete(controller);
      pending.delete(task);
      if (stopped) return;
      const next = setTimeout(() => {
        timers.delete(next);
        run(source, read, record);
      }, intervalMs);
      next.unref();
      timers.add(next);
    });
    pending.add(task);
  }

  run("outbox", options.readOutbox, options.metrics.recordOutbox);
  run("sqs", options.readQueue, options.metrics.recordQueue);
  return {
    async stop(): Promise<void> {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const controller of controllers) controller.abort(new Error("Backlog sampler stopped"));
      await Promise.allSettled(pending);
    },
  };
}
