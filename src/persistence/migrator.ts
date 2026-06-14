// 冪等マイグレーションランナー(Req 2.2, 2.3)。
//
// アルゴリズム(design.md「スキーマ初期化フロー(冪等マイグレーション)」):
//   1. schema_migrations 台帳を IF NOT EXISTS で確実に存在させる。
//   2. 適用済み version 集合を読み出す。
//   3. 未適用の version を昇順に、各 DDL を順次実行する。
//   4. 各 version 適用後、台帳に version と適用時刻を記録する。
// 各 DDL は再実行安全(IF NOT EXISTS)であり、version 台帳により全体が冪等。
//
// SQL 実行抽象(`MigrationSql`)は Cloudflare `SqlStorage.exec` の形を模倣する。
// 設計逸脱: design.md の `SqlExecutor`(タグ付きテンプレート)はリテラル値を
// パラメータとしてバインドするため、`SCHEMA_STATEMENTS` の生 DDL 文字列を実行できない。
// 本ランナーは生文字列 DDL を実行できる実 API(`SqlStorage.exec(query, ...bindings)`)に
// 適合する最小インターフェイスへ依存先を切り替える(設計意図=冪等適用は不変)。

import { MIGRATIONS, type Migration } from "./migrations";

/**
 * 永続化層が依存する最小 SQL 実行インターフェイス。
 * Cloudflare `SqlStorage.exec(query, ...bindings): SqlStorageCursor` の形に合わせ、
 * EvaluationCycleAgent が `this.ctx.storage.sql` をそのまま渡せるようにする。
 *
 * migrator と repository(task 2.3)はこの単一インターフェイスを共有する。
 */
export interface SqlLike {
  exec(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): Record<string, unknown>[] };
}

/**
 * migrator が依存する SQL 実行インターフェイス。
 * 互換性維持のため `SqlLike` の別名として保持する(既存の import を壊さない)。
 */
export type MigrationSql = SqlLike;

/** schema_migrations 台帳の DDL(version 主キー + 適用時刻)。 */
const LEDGER_DDL =
  "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)";

/** 台帳から適用済み version 集合を取得する。 */
function readAppliedVersions(sql: MigrationSql): Set<number> {
  const rows = sql.exec("SELECT version FROM schema_migrations").toArray();
  return new Set(rows.map((row) => Number(row.version)));
}

/**
 * 未適用のマイグレーションを昇順に適用する冪等ランナー。
 *
 * @param sql 対象 DO の `this.ctx.storage.sql`(本番)またはテスト用 SQL バックエンド。
 * @param migrations 適用対象のマイグレーション配列(既定: 全 §11 テーブルの v1)。
 */
export function runMigrations(
  sql: MigrationSql,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  // 1. 台帳を確実に存在させる(再実行安全)。
  sql.exec(LEDGER_DDL);

  // 2. 適用済み version を読み出す。
  const applied = readAppliedVersions(sql);

  // 3. 未適用分を version 昇順に適用する。
  const pending = migrations
    .filter((migration) => !applied.has(migration.version))
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    for (const statement of migration.statements) {
      sql.exec(statement);
    }
    // 4. 適用後に version を台帳へ記録する。
    sql.exec(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      migration.version,
      new Date().toISOString(),
    );
  }
}
