import { readFileSync } from "node:fs";

export function idleRequests(days: number, parallelReceives: number, pollSeconds: number, sampleSeconds: number) {
  const seconds = days * 86400;
  return { receive: seconds / pollSeconds * parallelReceives, sample: seconds / sampleSeconds, total: seconds / pollSeconds * parallelReceives + seconds / sampleSeconds };
}
if (import.meta.main) {
  const worker = readFileSync(new URL("../../packages/worker/src/index.ts", import.meta.url), "utf8");
  const sampler = readFileSync(new URL("../../packages/worker/src/metrics/backlog-sampler.ts", import.meta.url), "utf8");
  const read = (text: string, name: string) => {
    const match = text.match(new RegExp(`${name} = ([0-9_]+)`));
    if (!match) throw new Error(`Inspect changed source constant: ${name}`);
    return Number(match[1].replaceAll("_", ""));
  };
  console.log(JSON.stringify({ days: 60, monthly: idleRequests(30, read(worker, "RECEIVE_BATCHES"), read(worker, "LONG_POLL_SECONDS"), read(sampler, "BACKLOG_SAMPLE_INTERVAL_MS") / 1000), sixtyDays: idleRequests(60, read(worker, "RECEIVE_BATCHES"), read(worker, "LONG_POLL_SECONDS"), read(sampler, "BACKLOG_SAMPLE_INTERVAL_MS") / 1000), excludes: "workload, batching/chunks, SDK retries, errors, S3, transfer, other account usage" }, null, 2));
}
