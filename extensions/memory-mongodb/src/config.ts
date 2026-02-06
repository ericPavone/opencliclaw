export type TlsConfig = {
  caFile?: string;
  certKeyFile?: string;
  allowInvalidCerts?: boolean;
};

export type MongoDBConfig = {
  uri: string;
  database: string;
  agentId: string;
  tls?: TlsConfig;
  autoCapture: boolean;
  autoRecall: boolean;
};

const ALLOWED_TOP_KEYS = ["uri", "database", "agentId", "tls", "autoCapture", "autoRecall"];
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

    return {
      uri: resolveEnvVars(cfg.uri),
      database: typeof cfg.database === "string" ? cfg.database : "openclaw_memory",
      agentId: typeof cfg.agentId === "string" ? cfg.agentId : "default",
      tls,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
    };
  },
};
