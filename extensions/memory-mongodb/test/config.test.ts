import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mongodbConfigSchema } from "../src/config.js";

describe("mongodbConfigSchema.parse", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.TEST_MONGO_URI = process.env.TEST_MONGO_URI;
  });
  afterEach(() => {
    if (savedEnv.TEST_MONGO_URI === undefined) {
      delete process.env.TEST_MONGO_URI;
    } else {
      process.env.TEST_MONGO_URI = savedEnv.TEST_MONGO_URI;
    }
  });

  it("parses minimal config with only uri", () => {
    const cfg = mongodbConfigSchema.parse({ uri: "mongodb://localhost:27017" });
    expect(cfg.uri).toBe("mongodb://localhost:27017");
    expect(cfg.database).toBe("openclaw_memory");
    expect(cfg.agentId).toBe("default");
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.autoRecall).toBe(true);
    expect(cfg.tls).toBeUndefined();
  });

  it("parses full config with all fields", () => {
    const cfg = mongodbConfigSchema.parse({
      uri: "mongodb://myhost:27017",
      database: "my_db",
      agentId: "agent-1",
      autoCapture: false,
      autoRecall: false,
      tls: { caFile: "/ca.pem", certKeyFile: "/cert.pem", allowInvalidCerts: true },
    });
    expect(cfg.database).toBe("my_db");
    expect(cfg.agentId).toBe("agent-1");
    expect(cfg.autoCapture).toBe(false);
    expect(cfg.autoRecall).toBe(false);
    expect(cfg.tls).toEqual({
      caFile: "/ca.pem",
      certKeyFile: "/cert.pem",
      allowInvalidCerts: true,
    });
  });

  it("resolves env vars in uri", () => {
    process.env.TEST_MONGO_URI = "mongodb://resolved:27017";
    const cfg = mongodbConfigSchema.parse({ uri: "${TEST_MONGO_URI}" });
    expect(cfg.uri).toBe("mongodb://resolved:27017");
  });

  it("throws on missing env var", () => {
    delete process.env.NONEXISTENT_VAR_12345;
    expect(() => mongodbConfigSchema.parse({ uri: "${NONEXISTENT_VAR_12345}" })).toThrow(
      "Environment variable NONEXISTENT_VAR_12345 is not set",
    );
  });

  it("throws on null/undefined input", () => {
    expect(() => mongodbConfigSchema.parse(null)).toThrow("config required");
    expect(() => mongodbConfigSchema.parse(undefined)).toThrow("config required");
  });

  it("throws on array input", () => {
    expect(() => mongodbConfigSchema.parse([])).toThrow("config required");
  });

  it("throws on missing uri", () => {
    expect(() => mongodbConfigSchema.parse({ database: "test" })).toThrow("uri is required");
  });

  it("throws on empty uri", () => {
    expect(() => mongodbConfigSchema.parse({ uri: "" })).toThrow("uri is required");
  });

  it("throws on unknown top-level keys", () => {
    expect(() => mongodbConfigSchema.parse({ uri: "mongodb://x", bogus: true })).toThrow(
      "unknown keys: bogus",
    );
  });

  it("throws on unknown tls keys", () => {
    expect(() => mongodbConfigSchema.parse({ uri: "mongodb://x", tls: { foo: "bar" } })).toThrow(
      "unknown keys: foo",
    );
  });

  it("throws if tls is not an object", () => {
    expect(() => mongodbConfigSchema.parse({ uri: "mongodb://x", tls: "yes" })).toThrow(
      "tls must be an object",
    );
  });

  it("defaults autoCapture/autoRecall to true when not specified", () => {
    const cfg = mongodbConfigSchema.parse({ uri: "mongodb://x" });
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.autoRecall).toBe(true);
  });

  it("sets autoCapture/autoRecall to false only when explicitly false", () => {
    const cfg = mongodbConfigSchema.parse({
      uri: "mongodb://x",
      autoCapture: false,
      autoRecall: false,
    });
    expect(cfg.autoCapture).toBe(false);
    expect(cfg.autoRecall).toBe(false);
  });

  it("defaults routing to disabled with sensible defaults", () => {
    const cfg = mongodbConfigSchema.parse({ uri: "mongodb://x" });
    expect(cfg.routing).toEqual({
      enabled: false,
      defaultTier: "heavy",
      cacheTtlMs: 60_000,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 300_000, windowMs: 600_000 },
    });
  });

  it("parses routing config", () => {
    const cfg = mongodbConfigSchema.parse({
      uri: "mongodb://x",
      routing: { enabled: true, defaultTier: "mid", cacheTtlMs: 30000 },
    });
    expect(cfg.routing.enabled).toBe(true);
    expect(cfg.routing.defaultTier).toBe("mid");
    expect(cfg.routing.cacheTtlMs).toBe(30000);
  });

  it("throws on unknown routing keys", () => {
    expect(() =>
      mongodbConfigSchema.parse({ uri: "mongodb://x", routing: { enabled: true, bogus: true } }),
    ).toThrow("unknown keys: bogus");
  });

  it("throws if routing is not an object", () => {
    expect(() => mongodbConfigSchema.parse({ uri: "mongodb://x", routing: "yes" })).toThrow(
      "routing must be an object",
    );
  });

  it("defaults routing fields when partially specified", () => {
    const cfg = mongodbConfigSchema.parse({
      uri: "mongodb://x",
      routing: { enabled: true },
    });
    expect(cfg.routing.defaultTier).toBe("heavy");
    expect(cfg.routing.cacheTtlMs).toBe(60_000);
  });
});
