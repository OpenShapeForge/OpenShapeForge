// SPDX-License-Identifier: BUSL-1.1
import { HttpError } from "../rest/http-error.js";

/** Includes initializing transports: concurrent initialize requests cannot overbook. */
export class SessionCapacity {
  private total = 0;
  private tenants = new Map<string, number>();
  private actors = new Map<string, number>();
  constructor(private limits = { total: 1024, tenant: 128, actor: 16 }) {}
  acquire(tenant: string, user: string): () => void {
    const actor = JSON.stringify([tenant, user]);
    if (this.total >= this.limits.total || (this.tenants.get(tenant) ?? 0) >= this.limits.tenant ||
      (this.actors.get(actor) ?? 0) >= this.limits.actor) {
      throw new HttpError(429, "MCP_SESSION_LIMIT", "MCP session capacity reached; close an existing session and retry.");
    }
    this.total++;
    this.tenants.set(tenant, (this.tenants.get(tenant) ?? 0) + 1);
    this.actors.set(actor, (this.actors.get(actor) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      for (const [map, key] of [[this.tenants, tenant], [this.actors, actor]] as const) {
        const count = map.get(key)! - 1;
        if (count === 0) map.delete(key); else map.set(key, count);
      }
    };
  }
}
