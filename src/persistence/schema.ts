// spec §11 全テーブルの DDL 定義 (Req 2.1, 2.4, 2.5)。
//
// このモジュールは「スキーマの単一参照元」である。CREATE 文の集合のみを保持し、
// マイグレーションの適用順序・台帳(schema_migrations)は migrator(task 2.2)が所有する。
//
// 設計上の制約:
// - 全文 `CREATE TABLE IF NOT EXISTS` を用い、再実行を安全にする(design.md 再実行安全)。
// - 値域(列挙値)は SQLite CHECK ではなく共有 enum 型で保証する
//   (design.md「値域(列挙値)は共有 enum 型で保証」)。本ファイルでは既定値リテラルを
//   共有 enum 配列の要素として参照し、列挙ドリフトをコンパイル時に検出可能にする(Req 2.5)。
// - 文の並びは親→子の依存安全順(参照先テーブルが先)で固定する。

import type { EntityName, GOAL_STATUSES, MILESTONE_STATUSES, USEFULNESS_VALUES } from "../types";

// 列挙既定値を共有 enum 配列の要素として束縛する。
// 値が enum から外れた場合(ドリフト)、`as const` 由来の union 型に代入できず
// 型エラーとなるため、§11 既定値と共有 enum の整合がコンパイル時に保証される(Req 2.5)。
const GOAL_STATUS_DEFAULT: (typeof GOAL_STATUSES)[number] = "gray";
const MILESTONE_STATUS_DEFAULT: (typeof MILESTONE_STATUSES)[number] = "todo";
const EVIDENCE_USEFULNESS_DEFAULT: (typeof USEFULNESS_VALUES)[number] = "medium";

/**
 * §11 のテーブル名一覧(親→子の依存安全順)。
 * `EntityName`(= 共有ドメイン型のテーブル識別子)の部分集合であることを型で保証する。
 * `schema_migrations` 台帳は含めない(migrator が所有)。
 */
export const SCHEMA_TABLE_NAMES = [
  "evaluation_cycles",
  "goals",
  "milestones",
  "checkins",
  "evidence",
  "evidence_goal_links",
  "weekly_reviews",
  "drafts",
] as const satisfies readonly EntityName[];

/**
 * §11 全 8 テーブルの `CREATE TABLE IF NOT EXISTS` 文。
 * `SCHEMA_TABLE_NAMES` と同じ依存安全順で並ぶ。migrator(task 2.2)が
 * `Migration.statements` として消費する。
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  // §11.1 evaluation_cycles
  `CREATE TABLE IF NOT EXISTS evaluation_cycles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  // §11.2 goals(status 既定値: 'gray')
  `CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  success_criteria TEXT,
  evaluation_points TEXT,
  status TEXT NOT NULL DEFAULT '${GOAL_STATUS_DEFAULT}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  // §11.3 milestones(status 既定値: 'todo')
  `CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT '${MILESTONE_STATUS_DEFAULT}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  // §11.4 checkins
  `CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  week_start_date TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
  // §11.5 evidence(usefulness 既定値: 'medium')
  `CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  title TEXT,
  body TEXT NOT NULL,
  evidence_date TEXT NOT NULL,
  usefulness TEXT NOT NULL DEFAULT '${EVIDENCE_USEFULNESS_DEFAULT}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  // §11.6 evidence_goal_links
  `CREATE TABLE IF NOT EXISTS evidence_goal_links (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  relevance_score REAL NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
)`,
  // §11.7 weekly_reviews
  `CREATE TABLE IF NOT EXISTS weekly_reviews (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  week_start_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  risks TEXT,
  next_actions TEXT,
  created_at TEXT NOT NULL
)`,
  // §11.8 drafts
  `CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  goal_id TEXT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
];
