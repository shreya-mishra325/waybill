import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const root = resolve(import.meta.dir, "../../..");
const checkOnly = process.argv.includes("--check");
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("Only --check is supported");
const password = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
try {
  await writeFile(resolve(root, ".env.monitoring"), `GRAFANA_ADMIN_USER=admin\nGRAFANA_ADMIN_PASSWORD=${password}\n`, { flag: "wx", mode: 0o600 });
  console.log("Local Grafana credentials saved in .env.monitoring");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
}

const compose = ["docker", "compose", "--env-file", ".env.monitoring", "-f", "docker-compose.monitoring.yml"];
async function run(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
  try {
    if (await child.exited !== 0) throw new Error("Monitoring setup command failed");
  } finally {
    clearTimeout(timer);
  }
}
await run([...compose, "config", "--quiet"]);
if (checkOnly) {
  await run([...compose, "run", "--rm", "--no-deps", "--entrypoint", "promtool", "prometheus", "check", "config", "/etc/prometheus/prometheus.yml"]);
  await run([...compose, "run", "--rm", "--no-deps", "--workdir", "/etc/prometheus", "--entrypoint", "promtool", "prometheus", "test", "rules", "/etc/prometheus/rules.test.yml"]);
} else {
  await run([...compose, "up", "-d", "--wait"]);
  console.log("Prometheus: http://127.0.0.1:9090");
  console.log("Grafana: http://127.0.0.1:3300/d/waybill-services");
  console.log("Open .env.monitoring for local Grafana login credentials.");
}
