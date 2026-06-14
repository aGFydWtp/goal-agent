// 冪等マイグレーションランナーの検証(Req 2.1, 2.2, 2.3)。
//
// 本物の SQLite バックエンド(Node 組み込み `node:sqlite`)に対して、
// 空 DB からの全テーブル生成と、適用済み DB への再実行が冪等であること
// (エラーなし・既存データ保持・台帳重複なし)を検証する。
//
// 実行環境: vitest projects の "node" プロジェクト(environment: node)。
// pool-workers では `node:sqlite` が無いため、本スイートは Node で動かす。

import { describe, expect, it } from "vitest";
import { type Migration, MIGRATIONS } from "../src/persistence/migrations";
import { SCHEMA_TABLE_NAMES } from "../src/persistence/schema";
import { runMigrations } from "../src/persistence/migrator";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

/** sqlite_master から実テーブル名集合を取得する。 */
function tableNames(db: NodeSqliteBackend): Set<string> {
  const rows = db
    .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
    .toArray();
  return new Set(rows.map((r) => String(r.name)));
}

/** schema_migrations に記録された version の配列(昇順)。 */
function appliedVersions(db: NodeSqliteBackend): number[] {
  return db
    .exec("SELECT version FROM schema_migrations ORDER BY version")
    .toArray()
    .map((r) => Number(r.version));
}

describe("migrator: 冪等マイグレーションランナー", () => {
  it("空 DB に全 §11 テーブルと台帳を生成し version 1 を記録する (2.1, 2.2)", () => {
    const db = new NodeSqliteBackend();
    try {
      runMigrations(db);

      const tables = tableNames(db);
      for (const t of SCHEMA_TABLE_NAMES) {
        expect(tables.has(t)).toBe(true);
      }
      expect(tables.has("schema_migrations")).toBe(true);
      expect(appliedVersions(db)).toContain(1);
    } finally {
      db.close();
    }
  });

  it("適用済み DB への再実行はエラーなく既存データを保持し台帳を重複させない (2.3)", () => {
    const db = new NodeSqliteBackend();
    try {
      runMigrations(db);

      // サンプル行を挿入(再実行で消えないことを確認するため)。
      db.exec(
        `INSERT INTO evaluation_cycles
          (id, user_id, name, start_date, end_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "cyc-1",
        "user-1",
        "Q1",
        "2026-01-01",
        "2026-03-31",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      const before = appliedVersions(db);

      // 再実行はスローしないこと。
      expect(() => runMigrations(db)).not.toThrow();

      // 既存データが保持されること。
      const rows = db
        .exec("SELECT id FROM evaluation_cycles WHERE id = ?", "cyc-1")
        .toArray();
      expect(rows).toHaveLength(1);

      // 台帳に version 1 が重複していないこと。
      const after = appliedVersions(db);
      expect(after).toEqual(before);
      expect(after.filter((v) => v === 1)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("v1 適用済み DB には未適用の新規 version のみ適用する", () => {
    const db = new NodeSqliteBackend();
    try {
      // まず既定マイグレーション(v1)を適用。
      runMigrations(db);

      // v2 を追加した拡張マイグレーション配列で再実行。
      const extended: Migration[] = [
        ...MIGRATIONS,
        {
          version: 2,
          statements: [
            "CREATE TABLE IF NOT EXISTS extra_table (id TEXT PRIMARY KEY)",
          ],
        },
      ];

      runMigrations(db, extended);

      expect(tableNames(db).has("extra_table")).toBe(true);
      expect(appliedVersions(db)).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });
});
