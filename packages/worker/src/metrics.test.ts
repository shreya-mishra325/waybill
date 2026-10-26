import { expect, test } from "bun:test";
import { resolve } from "node:path";

const scenarios = [
  "publisher-success", "publisher-send-failure", "publisher-persist-failure", "publisher-duplicate",
  "success", "delete-failure", "retry", "retry-visibility-failure", "preparation", "retry-persist-failure",
  "exhausted", "exhausted-preparation", "archive-failure", "terminal-persist-failure",
  "circuit", "rate-limit", "not-due", "deferral-failure", "batch-partial", "batch-complete", "poison",
];

for (const scenario of scenarios) {
  test(`delivery metrics: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "metrics-scenarios.fixture.ts"), scenario], {
      env: {
        DATABASE_URL: "postgresql://metrics_test:metrics_test@127.0.0.1:1/metrics_test",
        AWS_REGION: "ap-southeast-2",
        S3_BUCKET_NAME: "waybill-metrics-test",
        AWS_EC2_METADATA_DISABLED: "true",
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const [exit, output, error] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw new Error(`${scenario} failed: ${error}\n${output}`);
      expect(output).toContain(`PASS ${scenario}`);
    } finally {
      clearTimeout(timer);
    }
  }, 10000);
}
