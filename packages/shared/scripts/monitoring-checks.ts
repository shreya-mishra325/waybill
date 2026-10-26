import { resolve } from "node:path";

export const root = resolve(import.meta.dir, "../../..");
const interruption = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => interruption.abort(new Error(`Check interrupted by ${signal}`)));
export async function waitFor(check: () => Promise<boolean>, label: string, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    interruption.signal.throwIfAborted();
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out: ${label}`);
}
export function startProcess(path: string, env: Record<string, string>, log: string) {
  interruption.signal.throwIfAborted();
  return Bun.spawn([process.execPath, "run", path], { cwd: root, env: { ...process.env, ...env },
    stdout: Bun.file(resolve(root, `logs/${log}.log`)), stderr: Bun.file(resolve(root, `logs/${log}.error.log`)) });
}
export type Child = ReturnType<typeof startProcess>;
export async function stopProcess(child: Child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
  try { await child.exited; } finally { clearTimeout(timer); }
}
export async function health(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    await response.text();
    return response.ok;
  } catch { return false; }
}
export async function metric(port: number, name: string, labels: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Metrics endpoint unavailable");
  let total = 0;
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith(name + "{") && !line.startsWith(name + " ")) continue;
    if (!Object.entries(labels).every(([key, value]) => line.includes(`${key}="${value}"`))) continue;
    total += Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return total;
}
export async function monitoringCommand(command: "stop" | "up") {
  const args = ["docker", "compose", "--env-file", ".env.monitoring", "-f", "docker-compose.monitoring.yml", command];
  if (command === "up") args.push("-d", "--wait");
  const child = Bun.spawn(args, { cwd: root, stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
  try {
    const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Monitoring command failed: ${error}`);
  } finally { clearTimeout(timer); }
}
