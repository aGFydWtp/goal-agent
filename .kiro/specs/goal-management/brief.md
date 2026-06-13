# Brief: goal-management

## Problem
評価サイクル・目標・証跡の「定義」を作成/編集/削除できなければ、分類も判定もドラフトも対象を持てない。半期サイクルと複数目標を登録し、安全に削除できる土台が要る。

## Current State
infra-foundation のスキーマ・Agent・型、discord-gateway のコマンド/modal/button 経路は存在するが、ドメイン CRUD は未実装。

## Desired Outcome
- `/cycle create name:.. start:.. end:..` で EvaluationCycleAgent が作成され、サイクルが保存される。
- `/goal add` が modal(目標名/本文/達成条件/評価観点/期限)を開き、GoalAgent を作成して目標定義を保存する。
- `/evidence delete id:..` で証跡を安全に削除できる(プライバシー必須要件)。
- 他ユーザーのデータにアクセスできない。

## Approach
discord-gateway のルーティングに各コマンドハンドラを登録。EvaluationCycleAgent がサイクル/目標一覧を管理し、目標ごとに GoalAgent を生成して定義を保持。CRUD は infra-foundation の永続化層経由。

## Scope
- **In**: `/cycle create`、`/goal add`(modal 起動・送信処理)、`/evidence delete`、サイクル/目標/証跡定義の保存・取得・削除、所有者スコープのアクセス制御、EvaluationCycleAgent/GoalAgent の定義状態管理。
- **Out**: 雑入力の分類(checkin-classification)、ステータス判定・ドラフト・`/status`・`/goal status`・`/draft`(status-and-draft)、`/evidence list` 表示(status-and-draft 側で扱うか要調整、本スペックは削除のみ)、`/goal edit`・`/cycle archive`(MVP 任意、必要なら本スペックの拡張)。

## Boundary Candidates
- サイクル CRUD(EvaluationCycleAgent)
- 目標 CRUD(GoalAgent 生成・定義保持)
- 証跡削除 + 所有者スコープ制御

## Out of Boundary
- 証跡の自動生成・分類(checkin-classification)
- 進捗判定・評価文(status-and-draft)
- 定期通知(notifications)

## Upstream / Downstream
- **Upstream**: infra-foundation, discord-gateway
- **Downstream**: checkin-classification(目標一覧・達成条件を参照)、status-and-draft(目標定義・証跡を参照)

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: checkin-classification(証跡を書き込む)、status-and-draft(証跡を読む)

## Constraints
- プライバシー(§15): 他ユーザーデータ不可、削除コマンド必須、DM/非公開チャンネル限定。
- 目標 ID は仕様書例(ai-adoption 等)のように人間可読 slug を許容するか design で確定。
- 達成条件/評価観点は複数行テキスト。スキーマ §11.2 に従う。
