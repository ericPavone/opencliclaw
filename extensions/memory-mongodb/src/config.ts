export type TlsConfig = {
  caFile?: string;
  certKeyFile?: string;
  allowInvalidCerts?: boolean;
};

export type RoutingConfig = {
  enabled: boolean;
  defaultTier: string;
  cacheTtlMs: number;
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
const ALLOWED_ROUTING_KEYS = ["enabled", "defaultTier", "cacheTtlMs"];
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

    let routing: RoutingConfig = { enabled: false, defaultTier: "heavy", cacheTtlMs: 60_000 };
    if (cfg.routing != null) {
      if (typeof cfg.routing !== "object" || Array.isArray(cfg.routing)) {
        throw new Error("routing must be an object");
      }
      const rc = cfg.routing as Record<string, unknown>;
      assertAllowedKeys(rc, ALLOWED_ROUTING_KEYS, "routing config");
      routing = {
        enabled: rc.enabled === true,
        defaultTier: typeof rc.defaultTier === "string" ? rc.defaultTier : "heavy",
        cacheTtlMs: typeof rc.cacheTtlMs === "number" && rc.cacheTtlMs > 0 ? rc.cacheTtlMs : 60_000,
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
