// 順序付きマイグレーション配列(Req 2.1)。
//
// このモジュールは「何を・どの順序で適用するか」を宣言する。実際の適用ロジック
// (台帳の確認・未適用分の適用・version 記録)は migrator.ts が所有する。
//
// 設計方針:
// - schema_migrations 台帳テーブルの作成自体はランナー(migrator)が
//   `runMigrations` の先頭で IF NOT EXISTS により保証する。よって本配列の
//   各 version の statements には台帳 DDL を含めない(関心の分離)。
// - §11 全 8 テーブルの作成を version 1 とする。各 DDL は schema.ts が
//   単一参照元として保持する `SCHEMA_STATEMENTS`(IF NOT EXISTS・再実行安全)。
// - 既存 version の statements は不変。スキーマ変更は新 version として追記する
//   (design.md Invariants: 既存 version の DDL は不変)。

import { SCHEMA_STATEMENTS } from "./schema";

/** 単一マイグレーション。version 昇順に未適用分のみ適用される(design.md Service Interface)。 */
export interface Migration {
  /** 適用順序を一意に定める version 番号(台帳の主キー)。 */
  version: number;
  /** この version で実行する DDL 文(各文は再実行安全であること)。 */
  statements: string[];
}

/**
 * 適用対象マイグレーションの順序付き配列。
 * version 1 = 仕様書 §11 全 8 テーブルの作成。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [...SCHEMA_STATEMENTS],
  },
];
