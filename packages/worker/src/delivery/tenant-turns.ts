export class TenantTurns {
  private readonly used = new Map<string, number>();

  constructor(private readonly limit = 10) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Tenant turn limit must be a positive integer");
  }

  take(tenantId: string): boolean {
    const count = this.used.get(tenantId) ?? 0;
    if (count >= this.limit) return false;
    this.used.set(tenantId, count + 1);
    return true;
  }
}
