// テスト専用: Node 組み込み `node:sqlite` (DatabaseSync) を migrator が依存する
// 最小 SQL インターフェイス(`MigrationSql`)に適合させるアダプタ。
//
// 目的: Durable Object を立てずに「本物の SQLite セマンティクス」
// (実際の `CREATE TABLE IF NOT EXISTS`・実際の台帳)に対して
// 冪等マイグレーションを検証できるようにする。
//
// 実行環境: このアダプタは Node 環境(vitest projects の node プロジェクト)でのみ
// 使用する。pool-workers (workerd) では `node:sqlite` が利用できないため。
//
// Cloudflare `SqlStorage.exec(query, ...bindings) -> SqlStorageCursor` の形を
// 模倣する(`.toArray()` / `.one()` を持つカーソル)。

import { DatabaseSync } from "node:sqlite";
import type { MigrationSql } from "../../src/persistence/migrator";

/** `node:sqlite` を `MigrationSql` に適合させたインメモリ SQL バックエンド。 */
export class NodeSqliteBackend implements MigrationSql {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
  }

  exec(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): Record<string, unknown>[]; one(): Record<string, unknown> } {
    // Cloudflare `SqlStorage.exec` は呼び出し時点で即時実行される。
    // 本アダプタもそれに合わせ、ここで eager に実行する(遅延評価しない)。
    const statement = this.db.prepare(query);
    // SELECT/PRAGMA/WITH は行を返す reader。それ以外(DDL/DML)は run() で実行する。
    const isReader = /^\s*(select|pragma|with)\b/i.test(query);
    const rows = isReader
      ? (statement.all(...bindings) as Record<string, unknown>[])
      : (() => {
          statement.run(...bindings);
          return [] as Record<string, unknown>[];
        })();
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) {
          throw new Error(`expected exactly one row, got ${rows.length}`);
        }
        // biome-ignore lint/style/noNonNullAssertion: length checked above
        return rows[0]!;
      },
    };
  }

  close(): void {
    this.db.close();
  }
}
