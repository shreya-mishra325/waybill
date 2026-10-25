import { describe, expect, test } from "bun:test";
import { DOC_CODE, DOC_TOPICS, docsHref, findDocTopic, searchDocs } from "../src/lib/docs";
import { parseDeliveryHistoryQuery } from "../../api/src/services/delivery-history-query";
import { parseDeadLetterQuery, parseDeadLetterPayloadQuery } from "../../api/src/services/dead-letter-query";
import { parseReplayQuery } from "../../api/src/services/replay-query";

const tenantId = "11111111-1111-4111-8111-111111111111";
const deadLetterId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const apiRoot = new URL("../../api/src/", import.meta.url);
const routeFiles = ["index.ts", "routes/events.ts", "routes/delivery-history.ts", "routes/dead-letters.ts"];
const registered = (await Promise.all(routeFiles.map(async file => {
  const source = await Bun.file(new URL(file, apiRoot)).text();
  return [...source.matchAll(/(?:app|\w+Router)\.(get|post)\("([^"]+)"/g)].map(match => ({ method: match[1]!.toUpperCase(), path: match[2]! }));
}))).flat();

test("documentation search resolves real topics and multiword queries", () => {
  expect(searchDocs("  HMAC signature ").map(topic => topic.slug)).toContain("authentication");
  expect(searchDocs("failed replay").map(topic => topic.slug)).toEqual(["retries-dead-letters"]);
  expect(searchDocs("does-not-exist")).toEqual([]);
  expect(searchDocs("   ")).toEqual([]);
  expect(findDocTopic("missing")).toBeUndefined();
  expect(new Set(DOC_TOPICS.map(topic => docsHref(topic.slug))).size).toBe(DOC_TOPICS.length);
  for (const topic of DOC_TOPICS) expect(findDocTopic(topic.slug)).toBe(topic);
});

test("setup examples reference existing scripts and repository sources", async () => {
  const packageFile = await Bun.file(new URL("../../../package.json", import.meta.url)).json() as { scripts: Record<string, string> };
  for (const command of [DOC_CODE.database, DOC_CODE.replica]) {
    for (const match of command.matchAll(/bun run ([\w:-]+)/g)) expect(packageFile.scripts[match[1]!]).toBeDefined();
  }
  for (const topic of DOC_TOPICS) for (const source of topic.sources) {
    expect(await Bun.file(new URL(`../../../${source}`, import.meta.url)).exists()).toBe(true);
  }
});

describe("published documentation HTTP commands", () => {
  for (const [name, code] of Object.entries(DOC_CODE).filter(([, value]) => value.startsWith("curl "))) {
    test.skipIf(!Bun.which("curl"))(`${name} matches a registered route and its actual query validation`, async () => {
      const requests: string[] = [];
      const errors: string[] = [];
      const server = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(request) {
        const url = new URL(request.url);
        const route = registered.find(route => route.method === request.method && new RegExp(`^${route.path.replace(/:[^/]+/g, "([^/]+)")}$`).test(url.pathname));
        if (!route) return Response.json({error: "Undocumented route"}, {status: 404});
        const values = url.pathname.split("/");
        const query = Object.fromEntries(url.searchParams);
        try {
          expect(request.headers.get("Authorization")).toBeNull();
          if (route.path.endsWith("/replay")) {
            parseReplayQuery(values[2], values[4], request.headers.get("Idempotency-Key"), await request.json(), query);
          } else if (route.path.endsWith("/payload")) parseDeadLetterPayloadQuery(values[2], values[4], query);
          else if (route.path.endsWith("/dead-letters")) parseDeadLetterQuery(values[2], query);
          else if (route.path.endsWith("/deliveries")) parseDeliveryHistoryQuery(values[2], query);
          else if (route.path.endsWith("/summary")) { expect(values[2]).toBe(tenantId); expect(query).toEqual({}); }
          requests.push(`${request.method} ${route.path}`);
          return Response.json({fixture: true}, {status: route.path.endsWith("/replay") ? 202 : 200});
        } catch (error) {
          errors.push(String(error));
          return Response.json({error: "Invalid documented request"}, {status: 400});
        }
      }});
      const substituted = code.replaceAll("http://127.0.0.1:3000", `http://127.0.0.1:${server.port}`)
        .replaceAll("REPLACE_WITH_TENANT_UUID", tenantId).replaceAll("REPLACE_WITH_DEAD_LETTER_UUID", deadLetterId).replaceAll("REPLACE_WITH_REQUEST_UUID", requestId);
      const child = Bun.spawn(["sh", "-c", substituted], {stdout: "pipe", stderr: "pipe"});
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(errors).toEqual([]);
        expect(stderr).not.toContain("SyntaxError");
        expect(status).toBe(0);
        expect(requests).toHaveLength(1);
        expect(stdout).toContain('"fixture":true');
      } finally { clearTimeout(timer); child.kill(); await server.stop(true); }
    });
  }
});
