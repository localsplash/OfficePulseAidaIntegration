/** Each configured dependency reports its own state; optional PBX inventory may be degraded while diagnostics remain ready. */

export type Criticality = 'critical' | 'degraded';

export interface ComponentState {
  ready: boolean;
  criticality: Criticality;
  detail?: string;
  since: string;
}

export interface ReadinessSnapshot {
  ready: boolean;
  /** True when every component, including non-critical ones, is ready. */
  fullyOperational: boolean;
  components: Record<string, ComponentState>;
}

export type ReadinessObserver = (name: string, ready: boolean, detail?: string) => void;

export class Readiness {
  private readonly components = new Map<string, ComponentState>();
  private readonly observers: ReadinessObserver[] = [];

  /**
   * @param criticality 'critical' components gate /readyz. 'degraded' ones
   * are reported but do not: the service still serves callers without them.
   */
  register(name: string, criticality: Criticality, ready = false, detail?: string): void {
    this.components.set(name, { ready, criticality, detail, since: new Date().toISOString() });
  }

  /** Notified on every transition, so changes can be recorded durably. */
  observe(observer: ReadinessObserver): void {
    this.observers.push(observer);
  }

  set(name: string, ready: boolean, detail?: string): void {
    const prev = this.components.get(name);
    if (!prev) return;
    if (prev.ready === ready && prev.detail === detail) return;
    this.components.set(name, { ...prev, ready, detail, since: new Date().toISOString() });
    for (const observer of this.observers) observer(name, ready, detail);
  }

  isReady(name: string): boolean {
    return this.components.get(name)?.ready ?? false;
  }

  snapshot(): ReadinessSnapshot {
    const components = Object.fromEntries(this.components.entries());
    let ready = this.components.size > 0;
    let fullyOperational = ready;
    for (const state of this.components.values()) {
      if (!state.ready) {
        fullyOperational = false;
        if (state.criticality === 'critical') ready = false;
      }
    }
    return { ready, fullyOperational, components };
  }

  allReady(): boolean {
    return this.snapshot().ready;
  }
}
