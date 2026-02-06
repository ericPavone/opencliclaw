import type { Collection } from "mongodb";
import { vi } from "vitest";

type MockCursor = {
  sort: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  toArray: ReturnType<typeof vi.fn>;
};

export function mockCursor(docs: unknown[]): MockCursor {
  const c: MockCursor = {
    sort: vi.fn(() => c),
    limit: vi.fn(() => c),
    toArray: vi.fn(() => Promise.resolve(docs)),
  };
  return c;
}

export function mockCollection(overrides?: Partial<Record<string, unknown>>): Collection {
  return {
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn(() => mockCursor([])),
    insertOne: vi.fn().mockResolvedValue({ insertedId: "mock-id" }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0, upsertedId: null }),
    updateMany: vi.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    ...overrides,
  } as unknown as Collection;
}
