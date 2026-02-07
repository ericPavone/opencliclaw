import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderHealthTracker } from "../src/provider-health.js";

describe("ProviderHealthTracker", () => {
  let tracker: ProviderHealthTracker;

  beforeEach(() => {
    tracker = new ProviderHealthTracker({ failureThreshold: 3, cooldownMs: 5000, windowMs: 10000 });
  });

  describe("initial state", () => {
    it("reports all models as healthy initially", () => {
      expect(tracker.isHealthy("google/gemini-3-pro")).toBe(true);
      expect(tracker.getState("google/gemini-3-pro")).toBe("closed");
    });

    it("snapshot is empty initially", () => {
      expect(Object.keys(tracker.snapshot())).toHaveLength(0);
    });
  });

  describe("circuit breaker states", () => {
    it("stays closed below failure threshold", () => {
      tracker.recordDecision("s1", "google/gemini-3-pro");
      tracker.recordOutcome("s1", false, "401");
      tracker.recordDecision("s2", "google/gemini-3-pro");
      tracker.recordOutcome("s2", false, "401");
      expect(tracker.getState("google/gemini-3-pro")).toBe("closed");
      expect(tracker.isHealthy("google/gemini-3-pro")).toBe(true);
    });

    it("opens after reaching failure threshold", () => {
      for (let i = 0; i < 3; i++) {
        tracker.recordDecision(`s${i}`, "google/gemini-3-pro");
        tracker.recordOutcome(`s${i}`, false, "429");
      }
      expect(tracker.getState("google/gemini-3-pro")).toBe("open");
      expect(tracker.isHealthy("google/gemini-3-pro")).toBe(false);
    });

    it("transitions to half-open after cooldown", () => {
      vi.useFakeTimers();
      try {
        for (let i = 0; i < 3; i++) {
          tracker.recordDecision(`s${i}`, "google/gemini-3-pro");
          tracker.recordOutcome(`s${i}`, false, "429");
        }
        expect(tracker.getState("google/gemini-3-pro")).toBe("open");

        vi.advanceTimersByTime(5001);
        expect(tracker.getState("google/gemini-3-pro")).toBe("half-open");
        expect(tracker.isHealthy("google/gemini-3-pro")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets to closed on success after half-open", () => {
      vi.useFakeTimers();
      try {
        for (let i = 0; i < 3; i++) {
          tracker.recordDecision(`s${i}`, "google/gemini-3-pro");
          tracker.recordOutcome(`s${i}`, false, "429");
        }
        vi.advanceTimersByTime(5001);
        expect(tracker.getState("google/gemini-3-pro")).toBe("half-open");

        tracker.recordDecision("s-recover", "google/gemini-3-pro");
        tracker.recordOutcome("s-recover", true);
        expect(tracker.getState("google/gemini-3-pro")).toBe("closed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-opens on failure during half-open", () => {
      vi.useFakeTimers();
      try {
        for (let i = 0; i < 3; i++) {
          tracker.recordDecision(`s${i}`, "google/gemini-3-pro");
          tracker.recordOutcome(`s${i}`, false, "429");
        }
        vi.advanceTimersByTime(5001);

        tracker.recordDecision("s-retry", "google/gemini-3-pro");
        tracker.recordOutcome("s-retry", false, "429");
        expect(tracker.getState("google/gemini-3-pro")).toBe("open");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("success resets", () => {
    it("resets consecutive failures on success", () => {
      tracker.recordDecision("s1", "google/gemini-3-pro");
      tracker.recordOutcome("s1", false, "401");
      tracker.recordDecision("s2", "google/gemini-3-pro");
      tracker.recordOutcome("s2", false, "401");
      tracker.recordDecision("s3", "google/gemini-3-pro");
      tracker.recordOutcome("s3", true);
      tracker.recordDecision("s4", "google/gemini-3-pro");
      tracker.recordOutcome("s4", false, "429");
      // Only 1 consecutive failure now
      expect(tracker.getState("google/gemini-3-pro")).toBe("closed");
    });
  });

  describe("window expiry", () => {
    it("resets failure count when window expires", () => {
      vi.useFakeTimers();
      try {
        tracker.recordDecision("s1", "google/gemini-3-pro");
        tracker.recordOutcome("s1", false, "401");
        tracker.recordDecision("s2", "google/gemini-3-pro");
        tracker.recordOutcome("s2", false, "401");

        // Jump past the window
        vi.advanceTimersByTime(11000);

        tracker.recordDecision("s3", "google/gemini-3-pro");
        tracker.recordOutcome("s3", false, "401");
        // Only 1 failure (window reset), not 3
        expect(tracker.getState("google/gemini-3-pro")).toBe("closed");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("manual resets", () => {
    it("resetModel clears a specific model", () => {
      for (let i = 0; i < 3; i++) {
        tracker.recordDecision(`s${i}`, "google/gemini-3-pro");
        tracker.recordOutcome(`s${i}`, false, "429");
      }
      expect(tracker.getState("google/gemini-3-pro")).toBe("open");
      tracker.resetModel("google/gemini-3-pro");
      expect(tracker.getState("google/gemini-3-pro")).toBe("closed");
    });

    it("resetAll clears everything", () => {
      for (let i = 0; i < 3; i++) {
        tracker.recordDecision(`s${i}`, "google/gemini-3-pro");
        tracker.recordOutcome(`s${i}`, false, "429");
      }
      tracker.resetAll();
      expect(tracker.getState("google/gemini-3-pro")).toBe("closed");
      expect(Object.keys(tracker.snapshot())).toHaveLength(0);
    });
  });

  describe("snapshot", () => {
    it("returns state for tracked models", () => {
      tracker.recordDecision("s1", "google/gemini-3-pro");
      tracker.recordOutcome("s1", false, "401");
      const snap = tracker.snapshot();
      expect(snap["google/gemini-3-pro"]).toBeDefined();
      expect(snap["google/gemini-3-pro"].state).toBe("closed");
      expect(snap["google/gemini-3-pro"].failures).toBe(1);
    });
  });

  describe("decision tracking", () => {
    it("ignores outcome without prior decision", () => {
      tracker.recordOutcome("unknown-session", false, "error");
      expect(Object.keys(tracker.snapshot())).toHaveLength(0);
    });

    it("tracks separate models independently", () => {
      for (let i = 0; i < 3; i++) {
        tracker.recordDecision(`s${i}`, "google/gemini-3-pro");
        tracker.recordOutcome(`s${i}`, false, "429");
      }
      tracker.recordDecision("s-ok", "anthropic/claude-opus-4-6");
      tracker.recordOutcome("s-ok", true);

      expect(tracker.isHealthy("google/gemini-3-pro")).toBe(false);
      expect(tracker.isHealthy("anthropic/claude-opus-4-6")).toBe(true);
    });
  });
});
