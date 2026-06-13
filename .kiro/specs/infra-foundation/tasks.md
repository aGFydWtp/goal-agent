# Implementation Plan

## 1. 基盤: プロジェクト雛形と共有型

- [x] 1.1 Cloudflare Worker + Agents SDK プロジェクト雛形を作成する
  - `agents` パッケージ・`wrangler`・TypeScript(strict)を依存に追加し、`dev`/`typecheck`/`deploy` のスクリプトを用意する
  - `wrangler` 設定に Worker 名・エントリーポイント・互換性日付・Workers AI バインディング・EvaluationCycleAgent/GoalAgent の Durable Object バインディングと `new_sqlite_classes` マイグレーションを宣言する
  - 型付き Env(Workers AI バインディングと両 DO バインディング)を定義し、最小の Worker エントリーポイントがリクエストに応答する
  - 完了条件: 型チェックコマンドがエラーなく完了し、ローカル開発サーバーが起動してルートへのリクエストに応答する
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 1.2 ローカル開発・型チェック・デプロイ手順のドキュメントを整備する
  - 前提(必要バインディング)、ローカル起動、型チェック、デプロイの手順を開発者向けに記載する
  - 完了条件: ドキュメント記載の手順どおりに型チェックとローカル起動が再現できる
  - _Requirements: 1.5_

- [x] 1.3 共有ドメイン型と列挙値型を定義する
  - 仕様書 §11 の各エンティティ(Cycle/Goal/Milestone/Checkin/Evidence/EvidenceGoalLink/WeeklyReview/Draft)に対応する型を定義する
  - 列挙値(goal status, milestone status, evidence source_type, evidence usefulness, draft type)を共有 enum 型として定義する
  - §13 で共通利用される基本型(関連度スコア、ステータス値、有用度)を定義する
  - 全下位スペックが単一参照元から import できるよう re-export する
  - 完了条件: 型が単一エントリから import 可能で、型チェックが通る
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 2.5_

## 2. 基盤: 永続化スキーマとマイグレーション

- [x] 2.1 仕様書 §11 全テーブルのスキーマ定義を作成する
  - evaluation_cycles, goals, milestones, checkins, evidence, evidence_goal_links, weekly_reviews, drafts の DDL を §11 通りに定義する(型・NOT NULL・既定値: goals.status='gray', milestones.status='todo', evidence.usefulness='medium')
  - 各テーブルの行型を共有ドメイン型と整合させる
  - 完了条件: 8 テーブル全ての DDL が定義され、列挙カラムが共有 enum 型と一致する
  - _Requirements: 2.1, 2.4, 2.5_
  - _Depends: 1.3_

- [x] 2.2 冪等マイグレーションランナーを実装する
  - 適用済みバージョンを記録する台帳テーブルと、順序付きマイグレーション配列を未適用分だけ適用するランナーを実装する
  - 各 DDL は再実行安全(IF NOT EXISTS)とし、適用後にバージョンを台帳へ記録する
  - 完了条件: 空の DB に対して全 §11 テーブルと台帳が生成され、適用済み DB への再実行ではエラーなく既存データが保持される
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 2.1_

- [x] 2.3 型付きリポジトリ(低レベル行アクセス)を実装する
  - エンティティ単位の insert/getById/listBy/update/remove を、DO SQLite 上で共有ドメイン型にマッピングして提供する
  - ドメインのビジネスルール(妥当性検証・状態遷移)は含めない
  - 完了条件: 各エンティティの read/write が型付きで動作し、書き込んだ行が同じ型で取得できる
  - _Requirements: 2.1, 2.4_
  - _Depends: 2.1, 2.2_

## 3. 基盤: LLM 抽象化レイヤ

- [x] 3.1 (P) LLM クライアントのインターフェイスとエラー型を定義する
  - テキスト補完と構造化 JSON 出力の共通インターフェイスを定義する
  - 判別可能なエラー型(provider_error/timeout/invalid_output)と結果型を定義する
  - 完了条件: 利用側がプロバイダ実装を知らずにインターフェイスとエラー型を import でき、型チェックが通る
  - _Requirements: 4.1, 4.5_
  - _Boundary: LlmClient + WorkersAi + Factory_
  - _Depends: 1.3_

- [x] 3.2 (P) Workers AI 実装とプロバイダ差し替えファクトリを実装する
  - Workers AI バインディング経由でテキスト補完を行う実装を提供し、構造化 JSON 出力のパース失敗を invalid_output として返す
  - プロバイダ/モデル選択を 1 箇所に集約するファクトリを実装し、利用側コードを変更せずに差し替え可能にする
  - 完了条件: ファクトリが返すクライアントが Workers AI で補完を返し、モデル/プロバイダ変更がファクトリ 1 箇所の変更で完結する
  - _Requirements: 4.2, 4.3, 4.4_
  - _Boundary: LlmClient + WorkersAi + Factory_
  - _Depends: 3.1_

## 4. 基盤: Agent トポロジと ID ルーティング

- [x] 4.1 (P) Agent ID 規約の組立/分解ユーティリティを実装する
  - 仕様書 §6 の ID 規約(cycle: `evaluation:{userId}:{cycleId}`、goal: `evaluation:{userId}:{cycleId}:goal:{goalId}`)で名前を組み立て、文字列を種別付きで分解する
  - 完了条件: 組立/分解が往復一致し、不正な ID 文字列は分解で null を返す
  - _Requirements: 3.2_
  - _Boundary: Agent IDs + Routing_
  - _Depends: 1.1_

- [ ] 4.2 EvaluationCycleAgent 骨格を実装する(データ権威)
  - サイクル単位 DO SQLite を権威として保持し、起動時にマイグレーションランナーを実行する
  - リポジトリを保持し、サイクル全体の管理・分類委譲・全体集約に対応する責務境界メソッドを骨格として宣言する(ドメインロジック本体は下位スペックが実装)
  - 完了条件: Agent 起動時にスキーマが初期化済みになり、リポジトリ経由でデータ読み書きが疎通する
  - _Requirements: 3.1, 3.5_
  - _Depends: 2.2, 2.3_

- [ ] 4.3 GoalAgent 骨格を実装する(目標単位ロジック)
  - 目標単位の定義保持・判定・生成の責務境界メソッドを骨格として宣言し、データ読み書きを親 EvaluationCycleAgent へ委譲する
  - 完了条件: GoalAgent からの操作が親リポジトリ経由で同一 SQLite に反映される
  - _Requirements: 3.1, 3.5_
  - _Depends: 4.2_

- [ ] 4.4 Agent 取得ルーティングヘルパーを実装する
  - userId/cycleId から EvaluationCycleAgent を、userId/cycleId/goalId から GoalAgent を取得するヘルパーを実装する
  - 完了条件: 同一引数の取得要求が同一論理 Agent インスタンスに解決し、取得後に対象 Agent が利用可能になる
  - _Requirements: 3.3, 3.4, 3.6_
  - _Depends: 4.1, 4.2, 4.3_

## 5. 統合: エントリーポイント配線

- [ ] 5.1 Worker エントリーポイントとルーティングヘルパー・Agent を配線する
  - Worker エントリーポイントがルーティングヘルパー経由で Agent を取得・疎通できるよう配線し、LLM ファクトリと Agent を結線する
  - 完了条件: ローカル起動した Worker からルーティングヘルパー経由で両 Agent に到達でき、スキーマ初期化と LLM クライアント生成が一連で疎通する
  - _Requirements: 1.2, 1.3, 3.3, 3.4, 4.4_
  - _Depends: 4.4, 3.2_

## 6. 検証

- [ ] 6.1 (P) 永続化とマイグレーションのユニットテスト
  - 空 DB から全 §11 テーブルと台帳が生成されること、適用済み DB への再実行が冪等で既存データを保持することを検証する
  - リポジトリの read/write が共有型と整合することを検証する
  - 完了条件: マイグレーション生成・冪等性・リポジトリ整合のテストが通る
  - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - _Boundary: Persistence Schema + Migrator, Repository_
  - _Depends: 2.3_

- [ ] 6.2 (P) ID 規約と LLM クライアントのユニットテスト
  - ID の組立/分解の往復一致と不正入力時の null を検証する
  - LLM クライアントの構造化出力パース失敗が invalid_output として返ることを検証する
  - 完了条件: ID ユーティリティと LLM エラー処理のテストが通る
  - _Requirements: 3.2, 4.5_
  - _Boundary: Agent IDs + Routing, LlmClient + WorkersAi + Factory_
  - _Depends: 4.1, 3.2_

- [ ] 6.3 Agent ルーティングと委譲の統合テスト
  - 同一引数で同一論理インスタンスに解決すること、起動時にスキーマ初期化済みであること、GoalAgent の操作が親リポジトリ経由で同一 SQLite に反映されることを検証する
  - LLM ファクトリが返すクライアントがバインディング経由で補完を返すこと(AI モック)を検証する
  - 完了条件: ルーティング・委譲・LLM ファクトリ疎通の統合テストが通る
  - _Requirements: 3.3, 3.4, 3.5, 3.6, 4.2, 4.3, 4.4_
  - _Depends: 5.1_

- [ ] 6.4 雛形のスモーク検証と境界整合の確認
  - 型チェックがエラーなく完了し、ローカル起動した Worker が応答すること(配線疎通)を確認する
  - Discord 検証・ドメイン CRUD・機能固有プロンプト/出力スキーマが本基盤に含まれていないこと(境界維持)を確認する
  - 完了条件: 型チェックとスモーク疎通が成功し、基盤境界外の責務が混入していないことが確認される
  - _Requirements: 1.1, 1.2, 1.3, 6.1, 6.2, 6.3, 6.4_
  - _Depends: 5.1_

## Implementation Notes
- 1.1/1.3: Workers AI バインディングはローカルシミュレータが無いため、`@cloudflare/vitest-pool-workers` は AI バインディング存在時に必ず remote proxy セッションを起動する(`ai.remote` フラグの有無に関わらず)。`pnpm test` を通すには Cloudflare 認証(`wrangler login` 済み)に加え `wrangler.jsonc` に `account_id` を明示する必要がある(未指定だと account ID 自動取得に失敗してテストプールが起動しない)。設定済み: account_id を wrangler.jsonc に記載。テストは remote 接続(~3s)で実行される。
- 1.3: EntityName は §11 テーブル名("evaluation_cycles","goals",...)を識別子に採用。nullable 列は一貫して `string | null`(optional `?` ではない)。enum は `as const` タプル + `(typeof X)[number]` で値配列と union 型を単一ソース化。downstream は `src/types` 単一エントリから import する。
- テスト配置: `test/` 配下はスキャフォールドの biome `includes`(`src/**`)・tsconfig `include` の対象外。テストは vitest/pool-workers の型環境でのみ型付けされる。
- 2.2 [設計 revalidation]: design.md L234 の `SqlExecutor`(タグ付きテンプレート型)は生 DDL 文字列を実行できない(補間値がパラメータバインドされる)。実装は実 Cloudflare API `SqlStorage.exec(query, ...bindings)` をモデルした最小 IF `MigrationSql { exec(query, ...bindings): { toArray() } }` に変更。task 4.2 で `this.ctx.storage.sql` を直接渡せる。設計意図(version 台帳での冪等適用)は不変。下位スペックは `SqlExecutor` ではなくこの exec 形 IF を前提にすること。
- 2.2 [vitest projects]: `pnpm test` は node プロジェクト(`environment: node`、`node:sqlite` 使用の純ロジック/永続化テスト)と workers プロジェクト(pool-workers、Cloudflare リモート接続)を両方実行する。**各プロジェクトは明示 `include` 許可リスト**なので、新規テストファイルは必ず vitest.config.ts の該当 `include` に追記しないと実行されない(サイレントに無視される)。永続化/純ロジック系→node、Workers ランタイム依存→workers。
- 2.2: マイグレーション v1 = 台帳 DDL + `SCHEMA_STATEMENTS`(schema.ts から import、再定義しない)。台帳は `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`。
- 3.2: Workers AI は `env.AI.run(model, inputs)` 入力 `{ prompt | messages, max_tokens, temperature }`(AiTextGenerationInput)・出力 `{ response?: string }`。モデル id は **factory.ts のみ**に集約(`@cf/meta/llama-3.1-8b-instruct-fp8`)、`WorkersAiLlmClient` はモデルをコンストラクタ注入。`completeJson` は JSON.parse 失敗・zod safeParse 失敗の両方を `invalid_output`(cause=parse error / zod issues)で返す。基盤呼び出し throw は provider_error、AbortError/TimeoutError は timeout。利用側は `LlmClient` 契約のみ依存。
- 2.3: SQL 実行 IF は `migrator.ts` の `SqlLike { exec(query, ...bindings): { toArray() } }`(`MigrationSql` は別名)に統一。repository は `SqlLike` を受け取る factory。値は全て `?` バインド、テーブル名は `SCHEMA_TABLE_NAMES`・列名は `TABLE_COLUMNS` で許可リスト検証(未知キーは throw)。ビジネスルール(値域/状態遷移/所有者)は持たない=下位スペック所有。task 4.2 では `this.ctx.storage.sql` を `SqlLike` として repository/migrator に渡せる。
