export function confirmedBatchReceipts(
  receipts: string[],
  result: { Successful?: { Id?: string }[]; Failed?: { Id?: string }[] },
): Set<string> {
  const requested = new Map(receipts.map((receipt, index) => [String(index), receipt]));
  const failed = new Set((result.Failed ?? []).map(entry => entry.Id));
  const confirmed = new Set<string>();
  for (const entry of result.Successful ?? []) {
    if (entry.Id === undefined || failed.has(entry.Id)) continue;
    const receipt = requested.get(entry.Id);
    if (receipt !== undefined) confirmed.add(receipt);
  }
  return confirmed;
}
