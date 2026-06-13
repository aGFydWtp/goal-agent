// 型付きリポジトリ(低レベル行アクセス)(Req 2.1, 2.4 / design.md Repository)。
//
// 責務: `this.sql`(= Cloudflare `SqlStorage.exec` 形)をラップし、§11 行を
// 共有ドメイン型(`EntityRow<E>`)へマッピングする read/write を提供する。
// ビジネスルール(妥当性検証・状態遷移・所有者チェック)は持たない。
// それらは下位スペック(checkin-classification 等)が所有する。
//
// 設計上の制約:
// - 全 SQL は値をパラメータ(`?` プレースホルダ + bindings)としてバインドし、
//   値を文字列連結しない(SQL インジェクション耐性)。
// - 識別子安全性: テーブル名は型付き `EntityName` union 由来だが、防御的に
//   `SCHEMA_TABLE_NAMES`(既知の §11 テーブル集合)に含まれることを検証してから
//   SQL に埋め込む。列識別子は型付き行/patch/where のキー由来であり、
//   各操作はオブジェクト自身の列挙可能キーのみを使用する(値は常にバインド)。
//   キー自体は SQL 識別子として埋め込まれるため、想定外キーを排除する目的で
//   テーブルごとの既知列集合に対して検証し、未知列はエラーとする。

import type { EntityName, EntityRow } from "../types";
import type { SqlLike } from "./migrator";
import { SCHEMA_TABLE_NAMES } from "./schema";

/** design.md Service Interface: エンティティ単位の型付き低レベル read/write。 */
export interface Repository {
  insert<E extends EntityName>(entity: E, row: EntityRow<E>): void;
  getById<E extends EntityName>(entity: E, id: string): EntityRow<E> | null;
  listBy<E extends EntityName>(entity: E, where: Partial<EntityRow<E>>): EntityRow<E>[];
  update<E extends EntityName>(entity: E, id: string, patch: Partial<EntityRow<E>>): void;
  remove<E extends EntityName>(entity: E, id: string): void;
}

/** バインド可能な値の型(Cloudflare `SqlStorage.exec` の binding と一致)。 */
type Bindable = string | number | null;

/**
 * テーブルごとの既知列集合(§11 / schema.ts の CREATE 文と一致)。
 * 列識別子は SQL に埋め込まれるため、想定外キーの混入を防ぐ検証に用いる。
 */
const TABLE_COLUMNS: Record<EntityName, readonly string[]> = {
  evaluation_cycles: [
    "id",
    "user_id",
    "name",
    "start_date",
    "end_date",
    "created_at",
    "updated_at",
  ],
  goals: [
    "id",
    "cycle_id",
    "user_id",
    "title",
    "description",
    "success_criteria",
    "evaluation_points",
    "status",
    "created_at",
    "updated_at",
  ],
  milestones: [
    "id",
    "goal_id",
    "title",
    "description",
    "due_date",
    "status",
    "created_at",
    "updated_at",
  ],
  checkins: ["id", "cycle_id", "user_id", "raw_text", "week_start_date", "created_at"],
  evidence: [
    "id",
    "cycle_id",
    "user_id",
    "source_type",
    "source_url",
    "title",
    "body",
    "evidence_date",
    "usefulness",
    "created_at",
    "updated_at",
  ],
  evidence_goal_links: ["id", "evidence_id", "goal_id", "relevance_score", "reason", "created_at"],
  weekly_reviews: [
    "id",
    "cycle_id",
    "user_id",
    "week_start_date",
    "summary",
    "risks",
    "next_actions",
    "created_at",
  ],
  drafts: ["id", "cycle_id", "goal_id", "user_id", "type", "body", "created_at", "updated_at"],
};

/** `entity` が §11 の既知テーブルであることを検証し、安全なテーブル名を返す。 */
function assertTable(entity: EntityName): EntityName {
  if (!(SCHEMA_TABLE_NAMES as readonly string[]).includes(entity)) {
    throw new Error(`unknown entity table: ${String(entity)}`);
  }
  return entity;
}

/** 列名が当該テーブルの既知列であることを検証する(SQL 識別子埋め込みの防御)。 */
function assertColumn(entity: EntityName, column: string): string {
  if (!TABLE_COLUMNS[entity].includes(column)) {
    throw new Error(`unknown column for ${entity}: ${column}`);
  }
  return column;
}

/** オブジェクトの自身の列挙可能キーのうち、検証済みの列名のみ抽出する。 */
function ownColumns(entity: EntityName, obj: Record<string, unknown>): string[] {
  return Object.keys(obj).map((key) => assertColumn(entity, key));
}

/**
 * `SqlStorage` が返す `Record<string, unknown>` を `EntityRow<E>` へ整形する。
 * §11 の全列は TEXT(→ string|null)または REAL(relevance_score → number)であり、
 * NULL は `null` のまま保持する。返却レコードを行型へキャストする。
 */
function mapRow<E extends EntityName>(record: Record<string, unknown>): EntityRow<E> {
  // SQLite は NULL を JS の null として返すため、追加変換は不要。
  // 行型は index signature を持たないため、`unknown` 経由でキャストする。
  // 型は schema.ts の列定義と一致する前提(Req 5.2 / 2.4)。
  return record as unknown as EntityRow<E>;
}

/** 行/patch/where を列アクセス用の `Record` として安全に見るためのヘルパ。 */
function asRecord(obj: unknown): Record<string, unknown> {
  return obj as Record<string, unknown>;
}

/**
 * 共有 SQL 実行インターフェイス(`SqlLike` = `SqlStorage.exec` 形)から
 * 型付きリポジトリを生成するファクトリ。
 *
 * @param sql 対象 DO の `this.ctx.storage.sql`(本番)またはテスト用 SQL バックエンド。
 */
export function createRepository(sql: SqlLike): Repository {
  return {
    insert<E extends EntityName>(entity: E, row: EntityRow<E>): void {
      const table = assertTable(entity);
      const record = asRecord(row);
      const columns = ownColumns(table, record);
      const placeholders = columns.map(() => "?").join(", ");
      const bindings = columns.map((col) => record[col] as Bindable);
      sql.exec(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
        ...bindings,
      );
    },

    getById<E extends EntityName>(entity: E, id: string): EntityRow<E> | null {
      const table = assertTable(entity);
      const rows = sql.exec(`SELECT * FROM ${table} WHERE id = ?`, id).toArray();
      const first = rows[0];
      return first === undefined ? null : mapRow<E>(first);
    },

    listBy<E extends EntityName>(entity: E, where: Partial<EntityRow<E>>): EntityRow<E>[] {
      const table = assertTable(entity);
      const record = asRecord(where);
      const columns = ownColumns(table, record);
      let query = `SELECT * FROM ${table}`;
      const bindings: Bindable[] = [];
      if (columns.length > 0) {
        const clauses = columns.map((col) => {
          bindings.push(record[col] as Bindable);
          return `${col} = ?`;
        });
        query += ` WHERE ${clauses.join(" AND ")}`;
      }
      return sql
        .exec(query, ...bindings)
        .toArray()
        .map((row) => mapRow<E>(row));
    },

    update<E extends EntityName>(entity: E, id: string, patch: Partial<EntityRow<E>>): void {
      const table = assertTable(entity);
      const record = asRecord(patch);
      const columns = ownColumns(table, record);
      // 空 patch は no-op(更新対象列が無いため何もしない)。
      if (columns.length === 0) {
        return;
      }
      const bindings: Bindable[] = [];
      const assignments = columns.map((col) => {
        bindings.push(record[col] as Bindable);
        return `${col} = ?`;
      });
      bindings.push(id);
      sql.exec(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ?`, ...bindings);
    },

    remove<E extends EntityName>(entity: E, id: string): void {
      const table = assertTable(entity);
      sql.exec(`DELETE FROM ${table} WHERE id = ?`, id);
    },
  };
}
