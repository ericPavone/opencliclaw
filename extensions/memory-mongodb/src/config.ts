export type TlsConfig = {
  caFile?: string;
  certKeyFile?: string;
  allowInvalidCerts?: boolean;
};

export type CircuitBreakerConfig = {
  failureThreshold: number;
  cooldownMs: number;
  windowMs: number;
};

export type RoutingConfig = {
  enabled: boolean;
  defaultTier: string;
  cacheTtlMs: number;
  circuitBreaker: CircuitBreakerConfig;
};

export type MongoDBConfig = {
  uri: string;
  database: string;
  agentId: string;
  tls?: TlsConfig;
  autoCapture: boolean;
  autoRecall: boolean;
  dbFirst: boolean;
  routing: RoutingConfig;
};

const ALLOWED_TOP_KEYS = [
  "uri",
  "database",
  "agentId",
  "tls",
  "autoCapture",
  "autoRecall",
  "dbFirst",
  "routing",
];
const ALLOWED_ROUTING_KEYS = ["enabled", "defaultTier", "cacheTtlMs", "circuitBreaker"];
const ALLOWED_CB_KEYS = ["failureThreshold", "cooldownMs", "windowMs"];
const ALLOWED_TLS_KEYS = ["caFile", "certKeyFile", "allowInvalidCerts"];

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

export const mongodbConfigSchema = {
  parse(value: unknown): MongoDBConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory-mongodb config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ALLOWED_TOP_KEYS, "memory-mongodb config");

    if (typeof cfg.uri !== "string" || !cfg.uri) {
      throw new Error("uri is required");
    }

    let tls: TlsConfig | undefined;
    if (cfg.tls != null) {
      if (typeof cfg.tls !== "object" || Array.isArray(cfg.tls)) {
        throw new Error("tls must be an object");
      }
      const tlsCfg = cfg.tls as Record<string, unknown>;
      assertAllowedKeys(tlsCfg, ALLOWED_TLS_KEYS, "tls config");
      tls = {
        caFile: typeof tlsCfg.caFile === "string" ? resolveEnvVars(tlsCfg.caFile) : undefined,
        certKeyFile:
          typeof tlsCfg.certKeyFile === "string" ? resolveEnvVars(tlsCfg.certKeyFile) : undefined,
        allowInvalidCerts: tlsCfg.allowInvalidCerts === true,
      };
    }

    const defaultCb: CircuitBreakerConfig = {
      failureThreshold: 3,
      cooldownMs: 300_000,
      windowMs: 600_000,
    };
    let routing: RoutingConfig = {
      enabled: false,
      defaultTier: "heavy",
      cacheTtlMs: 60_000,
      circuitBreaker: defaultCb,
    };
    if (cfg.routing != null) {
      if (typeof cfg.routing !== "object" || Array.isArray(cfg.routing)) {
        throw new Error("routing must be an object");
      }
      const rc = cfg.routing as Record<string, unknown>;
      assertAllowedKeys(rc, ALLOWED_ROUTING_KEYS, "routing config");

      let cb = defaultCb;
      if (rc.circuitBreaker != null) {
        if (typeof rc.circuitBreaker !== "object" || Array.isArray(rc.circuitBreaker)) {
          throw new Error("circuitBreaker must be an object");
        }
        const raw = rc.circuitBreaker as Record<string, unknown>;
        assertAllowedKeys(raw, ALLOWED_CB_KEYS, "circuitBreaker config");
        cb = {
          failureThreshold:
            typeof raw.failureThreshold === "number" && raw.failureThreshold > 0
              ? raw.failureThreshold
              : defaultCb.failureThreshold,
          cooldownMs:
            typeof raw.cooldownMs === "number" && raw.cooldownMs > 0
              ? raw.cooldownMs
              : defaultCb.cooldownMs,
          windowMs:
            typeof raw.windowMs === "number" && raw.windowMs > 0
              ? raw.windowMs
              : defaultCb.windowMs,
        };
      }

      routing = {
        enabled: rc.enabled === true,
        defaultTier: typeof rc.defaultTier === "string" ? rc.defaultTier : "heavy",
        cacheTtlMs: typeof rc.cacheTtlMs === "number" && rc.cacheTtlMs > 0 ? rc.cacheTtlMs : 60_000,
        circuitBreaker: cb,
      };
    }

    return {
      uri: resolveEnvVars(cfg.uri),
      database: typeof cfg.database === "string" ? cfg.database : "openclaw_memory",
      agentId: typeof cfg.agentId === "string" ? cfg.agentId : "default",
      tls,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      dbFirst: cfg.dbFirst === true,
      routing,
    };
  },
};
