export class VisibilityLeases {
  private readonly receipts = new Map<string, { expiresAt: number }>();
  private pending: Promise<void> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly renewBatch: (receipts: string[]) => Promise<Set<string>>,
    private readonly onError: (error: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => { void this.renewNow(); }, 10_000);
    this.timer.unref();
  }

  track(receipt: string): void {
    this.receipts.set(receipt, { expiresAt: this.now() + 30_000 });
  }

  get size(): number {
    return this.receipts.size;
  }

  get ownedSize(): number {
    const now = this.now();
    let count = 0;
    for (const entry of this.receipts.values()) {
      if (entry.expiresAt > now) count++;
    }
    return count;
  }

  isCurrent(receipt: string): boolean {
    return (this.receipts.get(receipt)?.expiresAt ?? 0) > this.now() + 5000;
  }

  async release(receipt: string): Promise<void> {
    this.receipts.delete(receipt);
    await this.pending;
  }

  renewNow(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.renewAll().then(
      () => { this.pending = undefined; },
      (err: unknown) => { this.pending = undefined; this.onError(err); },
    );
    return this.pending;
  }

  private async renewAll(): Promise<void> {
    const entries = [...this.receipts.entries()].filter(([, entry]) => entry.expiresAt > this.now());
    const batches = [];
    for (let offset = 0; offset < entries.length; offset += 10) batches.push(entries.slice(offset, offset + 10));
    await Promise.all(batches.map(async (batch) => {
      const startedAt = this.now();
      try {
        const confirmed = await this.renewBatch(batch.map(([receipt]) => receipt));
        for (const [receipt, entry] of batch) {
          if (this.receipts.get(receipt) !== entry) continue;
          entry.expiresAt = confirmed.has(receipt) ? startedAt + 30_000 : 0;
        }
        if (batch.some(([receipt]) => !confirmed.has(receipt))) {
          this.onError(new Error("SQS did not confirm every visibility renewal"));
        }
      } catch (err) {
        for (const [receipt, entry] of batch) {
          if (this.receipts.get(receipt) === entry) entry.expiresAt = 0;
        }
        this.onError(err);
      }
    }));
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.pending;
    this.receipts.clear();
  }
}
