# Requirements Document

## Project Description (Input)
評価目標フォロー Agent の全機能(Discord I/O、目標管理、分類、判定、通知)が依存する共通の実行基盤を構築する。グリーンフィールドの Cloudflare Workers + Agents SDK(TypeScript)プロジェクトとして、(a) `wrangler` でデプロイ可能なプロジェクト雛形、(b) 仕様書 §11 の全テーブルを定義する Durable Object SQLite スキーマとマイグレーション、(c) Agent トポロジ(EvaluationCycleAgent / GoalAgent、ID 規約 §6)の骨格と Agent 間ルーティング、(d) Workers AI を呼ぶ差し替え可能な LLM 抽象化レイヤ、(e) 全スペックから参照可能な共有ドメイン型、を提供する。これにより下位スペック(discord-gateway, goal-management, checkin-classification, status-and-draft, notifications)が安定した土台の上で独立実装できるようになる。

## Introduction
本スペックは評価目標フォロー Agent の「インフラ基盤(infra-foundation)」を定義する。これは上位の全機能スペックが共有する実行基盤であり、利用者(=下位スペックの実装者、およびシステム運用者)が観測できる契約として、デプロイ可能なプロジェクト雛形、永続化スキーマ、Agent トポロジと ID 規約、LLM 抽象化レイヤ、共有ドメイン型を提供する。本基盤自体はエンドユーザー向けの Discord 機能やドメイン CRUD を実装せず、それらが乗る土台のみを確立する。

## Boundary Context
- **In scope**: デプロイ可能な Cloudflare Worker + Agents SDK プロジェクト雛形(ビルド・型チェック・ローカル開発手順)、仕様書 §11 の全テーブルを定義する永続化スキーマと冪等なマイグレーション、Agent トポロジ(EvaluationCycleAgent / GoalAgent)の骨格と ID 規約に基づく Agent 間ルーティング、差し替え可能な LLM 抽象化レイヤ(`LlmClient` インターフェイスと Workers AI 実装)、全スペックから import 可能な共有ドメイン型。
- **Out of scope**: 具体的な slash command の検証・ルーティング(discord-gateway が所有)、Discord interactions の署名検証(discord-gateway が所有)、サイクル/目標/証跡のドメイン CRUD ロジック(goal-management が所有)、チェックイン分類・ステータス判定・評価文生成の各プロンプト本体と構造化出力スキーマ(各機能スペックが所有)、定期通知のスケジュールロジック(notifications が所有)。
- **Adjacent expectations**: 下位スペックは本基盤が公開する共有型・`LlmClient` インターフェイス・Agent 取得/ルーティングヘルパー・永続化スキーマを再定義せずに利用することを前提とする。スキーマ変更が必要な場合は本基盤スペックの拡張として扱い、下位スペックは独自にテーブルを追加・変更しない。

## Requirements

### Requirement 1: デプロイ可能なプロジェクト雛形
**Objective:** As a 基盤利用者(下位スペック実装者), I want `wrangler` でデプロイ可能なプロジェクト雛形, so that 各機能スペックが共通の実行環境とビルド手順の上で実装を開始できる

#### Acceptance Criteria
1. When 開発者がプロジェクトルートで型チェックコマンドを実行する, the インフラ基盤プロジェクト shall 型エラーなく完了する。
2. When 開発者がローカル開発サーバーの起動コマンドを実行する, the インフラ基盤プロジェクト shall Worker エントリーポイントを起動し、リクエストを受け付けられる状態になる。
3. The インフラ基盤プロジェクト shall Worker エントリーポイント・Agent クラス・Durable Object バインディングを宣言する設定ファイルを含む。
4. If 必須の環境バインディング(Workers AI、Durable Object)が設定されていない, then the インフラ基盤プロジェクト shall 起動時または型レベルで不足を検出可能にする。
5. The インフラ基盤プロジェクト shall ローカル開発・型チェック・デプロイの手順を記載した開発者向けドキュメントを含む。

### Requirement 2: 永続化スキーマとマイグレーション
**Objective:** As a 基盤利用者, I want 仕様書 §11 の全テーブルを定義する永続化スキーマと冪等なマイグレーション, so that ドメインデータを一貫した構造で保存・参照できる

#### Acceptance Criteria
1. The 永続化層 shall 仕様書 §11 の全テーブル(evaluation_cycles, goals, milestones, checkins, evidence, evidence_goal_links, weekly_reviews, drafts)を定義する。
2. When Agent が初めて永続化層を利用する, the 永続化層 shall 未適用のマイグレーションを適用し、全テーブルを利用可能な状態にする。
3. When マイグレーションが既に適用済みの状態で再度初期化が走る, the 永続化層 shall 重複適用やエラーを起こさず、既存データを保持する。
4. The 永続化層 shall 仕様書 §11 で定義された各カラムの型・NOT NULL 制約・既定値(例: goals.status の既定 'gray'、evidence.usefulness の既定 'medium'、milestones.status の既定 'todo')を保持する。
5. Where 列挙的な値を持つカラム(milestones.status, evidence.source_type, evidence.usefulness, drafts.type)が存在する, the 永続化層 shall 仕様書 §11 に列挙された値の集合を共有型として表現する。

### Requirement 3: Agent トポロジと ID 規約
**Objective:** As a 基盤利用者, I want EvaluationCycleAgent / GoalAgent の骨格と ID 規約に基づく Agent 間ルーティング, so that 上位機能が一貫した方法で Agent を特定・取得・委譲できる

#### Acceptance Criteria
1. The インフラ基盤 shall EvaluationCycleAgent と GoalAgent を Durable Object ベースの Agent クラスとして提供する。
2. The インフラ基盤 shall 仕様書 §6 の ID 規約(EvaluationCycleAgent は `evaluation:{userId}:{cycleId}`、GoalAgent は `evaluation:{userId}:{cycleId}:goal:{goalId}`)に従って Agent インスタンスを一意に特定する。
3. When 呼び出し元が userId と cycleId を指定する, the インフラ基盤 shall 対応する EvaluationCycleAgent インスタンスを取得するルーティングヘルパーを提供する。
4. When 呼び出し元が userId・cycleId・goalId を指定する, the インフラ基盤 shall 対応する GoalAgent インスタンスを取得するルーティングヘルパーを提供する。
5. The インフラ基盤 shall EvaluationCycleAgent と GoalAgent の責務分担(EvaluationCycleAgent=サイクル全体の管理と分類・委譲・全体集約、GoalAgent=目標単位の定義・証跡・判定・生成)を骨格メソッドの境界として表現する。
6. While 同一 ID に対する複数回の取得要求がある, the インフラ基盤 shall 同一の論理 Agent インスタンスに解決する。

### Requirement 4: 差し替え可能な LLM 抽象化レイヤ
**Objective:** As a 基盤利用者, I want プロバイダ/モデルを 1 箇所で差し替え可能な LLM 抽象化レイヤ, so that 各機能スペックがプロバイダ実装に依存せず LLM を呼び出せ、品質不足時にプロバイダを差し替えられる

#### Acceptance Criteria
1. The インフラ基盤 shall 各機能スペックが LLM を呼び出すための共通インターフェイス(`LlmClient`)を提供する。
2. The インフラ基盤 shall `LlmClient` の初期実装として Cloudflare Workers AI を呼び出す実装を提供する。
3. When 呼び出し元がプロンプトと構造化出力の指定を渡す, the LLM 抽象化レイヤ shall プロバイダ固有 API を隠蔽したうえで結果を返す。
4. Where LLM プロバイダまたはモデルを変更する必要が生じる, the LLM 抽象化レイヤ shall インターフェイスの利用側コードを変更せずに 1 箇所の設定/実装差し替えで切り替え可能にする。
5. If LLM 呼び出しが失敗する, then the LLM 抽象化レイヤ shall 利用側が判別・処理できる形でエラーを返す。

### Requirement 5: 共有ドメイン型
**Objective:** As a 基盤利用者, I want 全スペックから参照可能な共有ドメイン型, so that 各機能スペックが同一のデータ契約に基づいて独立実装できる

#### Acceptance Criteria
1. The インフラ基盤 shall 仕様書 §11 の各エンティティ(Cycle, Goal, Milestone, Checkin, Evidence, EvidenceGoalLink, WeeklyReview, Draft)に対応する共有型を提供する。
2. The 共有型 shall 永続化スキーマのカラム定義と整合する(型・必須/任意・列挙値が一致する)。
3. Where 仕様書 §13 で定義される LLM の構造化入出力に共通利用される基本型(例: 関連度スコア、ステータス値、証跡有用度)が存在する, the インフラ基盤 shall それらを共有型として提供する。
4. The 共有型 shall 全下位スペックから単一の参照元として import 可能な形で公開される。

### Requirement 6: 基盤境界の維持
**Objective:** As a システム運用者および基盤利用者, I want 基盤がドメイン機能を実装せず土台のみを提供すること, so that 上位スペックが責務を重複させず独立して実装・テスト・レビューできる

#### Acceptance Criteria
1. The インフラ基盤 shall Discord interactions の署名検証・コマンドルーティング・UX 文言を実装しない。
2. The インフラ基盤 shall サイクル/目標/証跡のドメイン CRUD ビジネスロジックを実装しない。
3. The インフラ基盤 shall チェックイン分類・ステータス判定・評価文生成の各プロンプト本体および機能固有の構造化出力スキーマを実装しない。
4. While 上位スペックが永続化スキーマの変更を必要とする, the インフラ基盤 shall スキーマの単独所有者として扱われ、変更は本基盤スペックの拡張として行われることを前提とする。
