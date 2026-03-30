import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MergeScoutStore } from "../store.js";

describe("sqlite-vec extension", () => {
  it("loads successfully and creates vec0 table", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vec-test-"));
    const store = new MergeScoutStore({ dbPath: join(tmp, "test.db") });
    await store.init();

    expect(store.vectorAvailable).toBe(true);

    const row = store.db.prepare("select vec_version() as v").get() as { v: string };
    expect(row.v).toMatch(/^v\d/);
  });

  it("can insert and query vectors", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vec-test-"));
    const store = new MergeScoutStore({ dbPath: join(tmp, "test.db") });
    await store.init();
    expect(store.vectorAvailable).toBe(true);

    const dim = 768;
    const vec1 = new Float32Array(dim);
    const vec2 = new Float32Array(dim);
    vec1[0] = 1.0;
    vec2[1] = 1.0;

    store.db
      .prepare("INSERT INTO issues_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)")
      .run(1, Buffer.from(vec1.buffer));
    store.db
      .prepare("INSERT INTO issues_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)")
      .run(2, Buffer.from(vec2.buffer));

    const queryVec = new Float32Array(dim);
    queryVec[0] = 1.0;

    const rows = store.db
      .prepare(
        `SELECT rowid, distance FROM issues_vec
         WHERE embedding MATCH ? ORDER BY distance LIMIT 2`,
      )
      .all(Buffer.from(queryVec.buffer)) as Array<{ rowid: number; distance: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]!.rowid).toBe(1);
    expect(rows[0]!.distance).toBeLessThan(rows[1]!.distance);
  });
});
