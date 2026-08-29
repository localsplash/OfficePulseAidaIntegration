/**
 * Dependency readiness registry. Each external dependency (ARI, MySQL,
 * AidaControl, provisioning adapter) reports its own state; /readyz
 * aggregates them. A dependency going down degrades readiness without
 * crashing the process — call handling falls back per the dialplan
 * contract and provisioning returns 503 until the dependency recovers.
 */

export interface ComponentState {
  ready: boolean;
  detail?: string;
  since: string;
}

export class Readiness {
  private readonly components = new Map<string, ComponentState>();

  register(name: string, ready = false, detail?: string): void {
    this.components.set(name, { ready, detail, since: new Date().toISOString() });
  }

  set(name: string, ready: boolean, detail?: string): void {
    const prev = this.components.get(name);
    if (prev && prev.ready === ready && prev.detail === detail) return;
    this.components.set(name, { ready, detail, since: new Date().toISOString() });
  }

  isReady(name: string): boolean {
    return this.components.get(name)?.ready ?? false;
  }

  allReady(): boolean {
    for (const state of this.components.values()) {
      if (!state.ready) return false;
    }
    return this.components.size > 0;
  }

  snapshot(): Record<string, ComponentState> {
    return Object.fromEntries(this.components.entries());
  }
}
