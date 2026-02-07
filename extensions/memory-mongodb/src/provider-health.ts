export type CircuitBreakerConfig = {
  failureThreshold: number;
  cooldownMs: number;
  windowMs: number;
};

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 300_000,
  windowMs: 600_000,
};

type ModelHealth = {
  consecutiveFailures: number;
  lastFailureAt: number;
  lastSuccessAt: number;
};

type Decision = {
  modelId: string;
  timestamp: number;
};

const DECISION_TTL_MS = 30 * 60_000;
const MAX_DECISIONS = 10_000;

export type CircuitState = "closed" | "open" | "half-open";

export class ProviderHealthTracker {
  private health = new Map<string, ModelHealth>();
  private decisions = new Map<string, Decision>();
  private cfg: CircuitBreakerConfig;

  constructor(cfg?: Partial<CircuitBreakerConfig>) {
    this.cfg = { ...DEFAULT_CIRCUIT_BREAKER, ...cfg };
  }

  getState(modelId: string): CircuitState {
    const h = this.health.get(modelId);
    if (!h || h.consecutiveFailures < this.cfg.failureThreshold) return "closed";
    const elapsed = Date.now() - h.lastFailureAt;
    if (elapsed >= this.cfg.cooldownMs) return "half-open";
    return "open";
  }

  isHealthy(modelId: string): boolean {
    return this.getState(modelId) !== "open";
  }

  recordDecision(sessionKey: string, modelId: string): void {
    this.decisions.set(sessionKey, { modelId, timestamp: Date.now() });
    if (this.decisions.size > MAX_DECISIONS) this.evictStale();
  }

  recordOutcome(sessionKey: string, success: boolean, _error?: string): void {
    const decision = this.decisions.get(sessionKey);
    if (!decision) return;
    this.decisions.delete(sessionKey);

    const modelId = decision.modelId;
    const h = this.health.get(modelId) ?? {
      consecutiveFailures: 0,
      lastFailureAt: 0,
      lastSuccessAt: 0,
    };

    if (success) {
      h.consecutiveFailures = 0;
      h.lastSuccessAt = Date.now();
    } else {
      const now = Date.now();
      if (h.lastFailureAt > 0 && now - h.lastFailureAt > this.cfg.windowMs) {
        h.consecutiveFailures = 1;
      } else {
        h.consecutiveFailures++;
      }
      h.lastFailureAt = now;
    }

    this.health.set(modelId, h);
  }

  resetModel(modelId: string): void {
    this.health.delete(modelId);
  }

  resetAll(): void {
    this.health.clear();
    this.decisions.clear();
  }

  snapshot(): Record<
    string,
    { state: CircuitState; failures: number; lastFailure: number; lastSuccess: number }
  > {
    const out: Record<
      string,
      { state: CircuitState; failures: number; lastFailure: number; lastSuccess: number }
    > = {};
    for (const [id, h] of this.health) {
      out[id] = {
        state: this.getState(id),
        failures: h.consecutiveFailures,
        lastFailure: h.lastFailureAt,
        lastSuccess: h.lastSuccessAt,
      };
    }
    return out;
  }

  private evictStale(): void {
    const cutoff = Date.now() - DECISION_TTL_MS;
    for (const [key, d] of this.decisions) {
      if (d.timestamp < cutoff) this.decisions.delete(key);
    }
  }
}
