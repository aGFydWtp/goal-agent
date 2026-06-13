# Roadmap

## Overview

半期の評価目標を Discord Bot 経由で継続追跡する Agent を構築する。ユーザーは週次で「今週やったこと」を雑に入力するだけでよく、Agent が内容を各評価目標に分類・証跡化し、進捗判定・不足指摘・次アクション提案・評価文ドラフト生成までを Discord チャット UI 上で完結させる。専用 Web ダッシュボードは作らない。

検証したい中心仮説は「評価目標管理はダッシュボードより、毎週聞いてくれるチャット Agent の方が継続する」である。MVP はこの仮説検証に必要な最小機能に絞る。

## Approach Decision

- **Chosen**: Cloudflare Worker(Discord HTTP interactions エンドポイント)+ Cloudflare Agents SDK(`agents` パッケージ、Durable Object ベース)+ Durable Object SQLite による永続化。LLM は Cloudflare Workers AI(オンプラットフォーム)。spec を 6 つの細粒度スペックに分解し、依存ウェーブ順に MVP を構築する。
- **Why**:
  - Worker は常駐 Gateway WebSocket を持てないが、slash command / modal / button はすべて HTTP POST で届くため interactions エンドポイント方式が正攻法(調査で確認済み)。
  - Agents SDK は GA で `this.sql`(DO SQLite, GA)と `this.schedule()`(DO alarm ベースの cron, 分粒度)を備え、週次チェックイン通知・状態保持に適合する。
  - Workers AI はエッジ同居で低レイテンシ・低コスト。MVP の検証速度を優先するユーザー選好に合致。
- **Rejected alternatives**:
  - 常駐 Gateway Bot(discord.js full): Worker ランタイムで WebSocket 常駐不可。却下。
  - LLM に Anthropic Claude API: 日本語品質は最も高いが、ユーザーはコスト/レイテンシ/オンプラットフォーム統合を優先し Workers AI を選択。抽象化レイヤで後から差し替え可能にする。
  - 単一スペックでの一括実装: 20+ タスクになり独立実装・レビューが困難。却下。

## Scope

- **In**(MVP / 仕様書 §17・§20):
  - Discord Bot(HTTP interactions エンドポイント)
  - コマンド: `/cycle create`, `/goal add`, `/checkin`, `/status`, `/goal status`, `/draft`
  - 保存確認ボタン(保存/修正/破棄)
  - 週次チェックイン通知(初期: 毎週金曜 16:30)
  - Red/Yellow アラート(状態悪化・証跡なし継続・半期終了前)
  - LLM 処理: チェックイン分類 / ステータス判定 / 評価文ドラフト生成(Workers AI)
  - Cloudflare Agents(EvaluationCycleAgent / GoalAgent)+ DO SQLite 永続化
  - プライバシー必須要件: DM/個人用非公開チャンネル限定、保存前確認、ドラフト扱い、削除コマンド(`/evidence delete`)
- **Out**(仕様書 §17「作らないもの」/ Phase 2-4):
  - Web ダッシュボード / 証跡一覧・編集 Web 画面
  - GitHub / Slack 自動連携
  - Google Calendar 連携(`/prepare 1on1` は手動コマンドの将来枠のみ、MVP では実装しない)
  - 複数ユーザー管理画面 / 上司共有 / 人事評価システム連携
  - Evidence Inbox / Discord メッセージからの証跡登録

## Constraints

- **技術**: Cloudflare Workers + Agents SDK(`agents`、`@cloudflare/agents` は非推奨)+ Durable Object SQLite。Discord HTTP interactions(Ed25519 署名検証必須、PING/PONG 応答必須、3秒以内の deferred 応答 + follow-up webhook パターン)。
- **LLM**: Cloudflare Workers AI を採用。ただし**日本語のニュアンス分類・評価文生成の品質は未検証リスク**。対策として基盤スペックに LLM 抽象化レイヤを設け、プロバイダ/モデルを 1 箇所で差し替え可能にする。実データの週次メモで日本語対応モデル(例: GLM-4.7-Flash)を早期ベンチマークし、品質不足なら Claude API へ差し替え可能とする。
- **プライバシー**(仕様書 §15、必須): 他ユーザーのデータにアクセス不可、保存前にユーザー確認、自動分類は即確定しない、生成評価文は必ずドラフト扱い、削除コマンドを用意。
- **運用**: DO SQLite ストレージは 2026-01-07 以降課金対象(本用途では小規模)。プロアクティブ DM は対象ユーザーがギルド共有/DM 許可している必要があり、失敗時はチャンネルメッセージにフォールバック。
- **言語**: プロジェクトに書き出す Markdown は日本語(spec.json.language に従う)。

## Boundary Strategy

- **Why this split**: 「インフラ基盤」「Discord I/O」「ドメイン CRUD」「LLM 分類」「LLM 判定/生成」「定期通知」は責務が明確に分かれ、それぞれ独立してテスト・レビューできる。基盤と Discord ゲートウェイを先に固めることで、上位 3 機能スペックが安定した土台の上で並行実装可能になる。
- **Shared seams to watch**:
  - **データモデル/SQLite スキーマ**(全テーブル §11): 基盤スペックが単独所有。他スペックはスキーマを追加変更しない(必要なら基盤スペックの拡張として扱う)。
  - **LLM 抽象化レイヤ**: 基盤が共有クライアントを提供し、各機能スペックは自分のプロンプト/構造化出力のみを所有する。
  - **Agent トポロジ**: 仕様書は EvaluationCycleAgent + 目標ごと GoalAgent を想定。調査ではユーザー単位 Agent も選択肢。**design フェーズで確定すべき設計論点**として基盤スペックで扱う。境界(どの責務がどの Agent か)は基盤スペックの design で決める。
  - **Discord deferred 応答**: LLM を呼ぶコマンド(checkin/status/draft)はゲートウェイの defer + follow-up パターンに依存。各機能スペックはこの規約に従う。

## Specs (dependency order)

- [x] infra-foundation -- Cloudflare Worker/Agents SDK プロジェクト雛形、DO SQLite スキーマ(全テーブル §11)とマイグレーション、Agent トポロジ確定(EvaluationCycleAgent/GoalAgent 骨格)、LLM 抽象化レイヤ(Workers AI)、共有型。Dependencies: none
- [x] discord-gateway -- Discord HTTP interactions エンドポイント(Ed25519 検証・PING/PONG)、slash command 登録、deferred 応答 + follow-up、modal/button ルーティング、プロアクティブ REST メッセージ送信(DM/チャンネル)ヘルパー。Dependencies: infra-foundation
- [x] goal-management -- `/cycle create`、`/goal add`(modal)、`/evidence delete`、サイクル/目標/証跡の定義 CRUD と EvaluationCycleAgent/GoalAgent の定義状態管理。Dependencies: infra-foundation, discord-gateway
- [x] checkin-classification -- `/checkin` フロー、Workers AI による雑入力の目標分類(関連度スコア §13.1)、証跡化、保存/修正/破棄ボタン、保存後の週次レビュー生成。Dependencies: infra-foundation, discord-gateway, goal-management
- [x] status-and-draft -- `/status`、`/goal status`、`/draft`、ステータス判定(ルール + LLM §10/§13.2)、評価文ドラフト生成(事実/解釈/課題/次アクション分離 §13.3)と調整ボタン。Dependencies: infra-foundation, discord-gateway, goal-management
- [x] notifications -- 週次チェックイン通知(`this.schedule()` cron、初期 金曜16:30)、Red/Yellow アラート(状態悪化・証跡なし2週継続・半期終了30/14日前 §9.3)。Dependencies: infra-foundation, discord-gateway, status-and-draft
