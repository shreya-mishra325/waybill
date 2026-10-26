import { expect, test } from "bun:test";
import { confirmedBatchReceipts } from "./queue-confirmations";

test("batch confirmation counts only unique requested successes without explicit failures", () => {
  expect([...confirmedBatchReceipts(["first", "second"], {
    Successful: [{ Id: "0" }, { Id: "0" }, { Id: "1" }, { Id: "2" }, { Id: "00" }, {}],
    Failed: [{ Id: "1" }],
  })]).toEqual(["first"]);
  expect(confirmedBatchReceipts(["first"], {}).size).toBe(0);
});
