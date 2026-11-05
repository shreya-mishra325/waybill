import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(mode: "deny" | "expire" | "crash") {
  const folder = await mkdtemp(join(tmpdir(), "waybill-wrapper-"));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const fake = join(folder, "bun");
  try {
    await writeFile(fake, `#!/bin/bash
set -eu
if [[ "\${2:-}" == lease ]]; then
  if [[ "$MODE" == deny ]]; then exit 1; fi
  n=0
  if [[ -f checks ]]; then n=$(cat checks); fi
  n=$((n+1))
  printf '%s' "$n" > checks
  if [[ "$MODE" == expire && "$n" -ge 2 ]]; then exit 1; fi
  exit 0
fi
if [[ "$MODE" == crash ]]; then exit 3; fi
exec /bin/sleep 30
`, { mode: 0o755 });
    const original = await readFile(new URL("./run.sh", import.meta.url), "utf8");
    const code = original.replace("cd /opt/waybill/current", `cd ${quote(folder)}`).replaceAll("/usr/local/bin/bun", quote(fake)).replaceAll("sleep 10", "sleep 0.05").replaceAll("sleep 1", "sleep 0.05");
    const script = join(folder, "run.sh");
    await writeFile(script, code);
    const child = Bun.spawn(["/bin/bash", script, "api"], { env: { PATH: "/usr/bin:/bin", MODE: mode }, stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
    try { return await child.exited; } finally { clearTimeout(timer); }
  } finally { await rm(folder, { recursive: true, force: true }); }
}
test("backend wrapper refuses missing permission and terminates when permission expires", async () => {
  expect(await run("deny")).toBe(78);
  expect(await run("expire")).toBe(78);
});
test("backend wrapper preserves a child failure for systemd restart", async () => {
  expect(await run("crash")).toBe(3);
});
