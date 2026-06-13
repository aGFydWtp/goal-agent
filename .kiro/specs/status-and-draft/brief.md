# Brief: status-and-draft

## Problem
証跡が貯まっても、進捗の現状把握と評価文への変換ができなければ「評価前に思い出す負担を減らす」という価値が出ない。蓄積データを Green/Yellow/Red で見立て、自己評価ドラフトに変換する機能が要る。

## Current State
infra-foundation・discord-gateway・goal-management が揃い、checkin-classification により証跡が蓄積される。判定・閲覧・ドラフト機能が未実装。

## Desired Outcome
- `/status` が半期全体の各目標状態(Green/Yellow/Red/Gray)と理由・今週やるとよいことを返す(§8.4)。
- `/goal status goal:..` が特定目標の見立て・保存済み証跡・不足・次アクションを返す(§8.5)。
- `/draft goal:..` / `/draft all` が事実/解釈/課題/次アクションを分離した自己評価ドラフトを生成し、[短くする][成果を強める][課題を明確にする][上司向けにする][保存] ボタンを出す(§8.7)。
- 判定はルール(§10.2)+ LLM の見立て(§13.2)。誇張せず、証跡にない内容は推測扱い(§13.3)。

## Approach
GoalAgent が自目標の証跡・達成条件・期限・経過日数を集約し、ルール前処理 + Workers AI で状態と理由・risks・nextActions を算出。EvaluationCycleAgent が `/status` で全目標を集約。`/draft` は対象証跡を取得し §13.3 の構成で生成、調整ボタンで再生成。discord-gateway の deferred + follow-up を使用。

## Scope
- **In**: `/status`、`/goal status`、`/draft`(goal/all)、ステータス判定(ルール + LLM §10/§13.2)、評価文ドラフト生成(§13.3)+ 調整ボタン処理 + drafts 保存。`/evidence list` 表示もここで扱う(証跡の閲覧)。
- **Out**: 証跡の生成・分類(checkin-classification)、定義 CRUD(goal-management)、状態変化を起点とする通知送信(notifications が判定結果を購読)。

## Boundary Candidates
- ステータス判定エンジン(ルール + LLM、状態 + 理由 + risks + nextActions)
- 進捗閲覧コマンド(`/status`, `/goal status`, `/evidence list`)
- 評価文ドラフト生成 + 調整ボタン + 保存

## Out of Boundary
- 分類・証跡化(checkin-classification)
- 通知のトリガ/配信(notifications。本スペックは判定結果を提供)
- スキーマ定義(infra-foundation)

## Upstream / Downstream
- **Upstream**: infra-foundation, discord-gateway, goal-management(+ checkin-classification の証跡を前提に価値が出る)
- **Downstream**: notifications(ステータス判定結果を Red/Yellow アラートに利用)

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: checkin-classification(証跡の供給元)、notifications(判定結果の消費者)

## Constraints
- 判定は §10.2 のルールベース + LLM 見立ての併用。Gray は判断材料不足。
- ドラフトは必ずドラフト扱い・誇張しない・証跡にない内容は推測明示(§13.3, §15)。
- LLM は Workers AI(日本語生成品質リスク → 抽象化レイヤで差し替え可能)。
- deferred + follow-up でレイテンシ吸収。
