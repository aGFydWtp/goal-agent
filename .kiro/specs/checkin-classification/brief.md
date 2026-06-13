# Brief: checkin-classification

## Problem
本プロジェクトの中心仮説は「毎週聞いてくれるチャット Agent なら継続する」。その核心が、ユーザーの雑な週次入力を各評価目標に自動分類し、確認の上で証跡化するフローである。これが無ければ製品価値が成立しない。

## Current State
infra-foundation(LLM クライアント・スキーマ)、discord-gateway(deferred/button)、goal-management(目標定義・証跡保存)が揃っている。分類ロジックと `/checkin` フローが未実装。

## Desired Outcome
- `/checkin` が「今週やったことを雑に書いてください」と促し、ユーザーの自然文返信を受け取る。
- Workers AI が入力を分解し、各項目を候補目標に関連度スコア付きで分類する(§13.1 の JSON 出力形式)。
- 分類案を Discord に提示し、[保存]/[修正]/[破棄] ボタンで確定する(自動確定しない)。
- 保存後、証跡と evidence_goal_links が作成され、週次レビュー(summary/risks/next_actions)が生成される。

## Approach
discord-gateway の deferred + follow-up パターンで `/checkin` を処理。EvaluationCycleAgent が目標一覧 + 達成条件をコンテキストに Workers AI を呼び、構造化分類を取得。結果を確認メッセージ(§14.1)として返し、ボタン確定で証跡・リンクを保存し週次レビュー(§14.2)を生成。

## Scope
- **In**: `/checkin` フロー、雑入力 → 構造化分類(関連度スコア・usefulness・suggested title)、分類確認 UX、[保存]/[修正]/[破棄] 処理、証跡 + evidence_goal_links 保存、保存後の週次レビュー生成・提示。
- **Out**: 目標/サイクル定義の CRUD(goal-management)、ステータス判定そのもの(status-and-draft が所有、保存後メッセージで見立てを参照する程度)、評価文ドラフト(status-and-draft)、定期通知トリガ(notifications)。

## Boundary Candidates
- `/checkin` 会話フロー(プロンプト → 返信受領)
- 分類 LLM プロンプト + 構造化出力パース(§13.1)
- 分類確認 UX + 保存/修正/破棄ボタン処理
- 証跡化 + 週次レビュー生成

## Out of Boundary
- ステータス Green/Yellow/Red 判定ルール(status-and-draft)
- 評価文生成(status-and-draft)
- スキーマ定義(infra-foundation)

## Upstream / Downstream
- **Upstream**: infra-foundation, discord-gateway, goal-management
- **Downstream**: status-and-draft(蓄積された証跡を判定/ドラフトに利用)、notifications(週次チェックイン通知が本フローを起動)

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: goal-management(証跡書き込み先)、status-and-draft(保存後の見立て表示で状態判定を呼ぶ可能性)

## Constraints
- 自動分類は即確定しない・保存前にユーザー確認(§15 必須)。
- LLM は Workers AI。日本語分類品質リスクあり → 抽象化レイヤ経由でモデル差し替え可能に。実データでの精度確認を design/impl で行う。
- 出力は §13.1 の JSON スキーマ(items[].candidateGoals[].relevanceScore など)に準拠。
- deferred 応答(3秒以内)+ follow-up で LLM レイテンシを吸収。
