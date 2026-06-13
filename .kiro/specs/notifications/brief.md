# Brief: notifications

## Problem
中心仮説は「毎週聞いてくれる」こと。ユーザーが自発的に `/checkin` するのを待つのでは継続しない。定期的にこちらから促し、状態が悪化した目標を能動的に知らせる仕組みが、継続利用(成功指標)の鍵になる。

## Current State
infra-foundation(Agent + `this.schedule()`)、discord-gateway(プロアクティブ送信ヘルパー)、status-and-draft(ステータス判定)が揃っている。スケジューリングとアラートが未実装。

## Desired Outcome
- 毎週金曜 16:30 にチェックイン通知が DM/個人用非公開チャンネルへ届く。通知には現在の Green/Yellow/Red 件数を含む(§9.1)。
- 状態悪化や停滞で Red/Yellow アラートが届く(§9.3 のトリガ: Green→Yellow、Yellow→Red、証跡なし2週継続、半期終了30日前、14日前)。
- アラートには理由と改善導線(`/goal status <id>` の案内)が含まれる。

## Approach
各 Agent(ユーザー/サイクル)が `this.schedule()` の cron(初期 金曜16:30)で週次通知をスケジュールし、status-and-draft の判定結果で件数を埋めて discord-gateway の送信ヘルパーで配信。状態遷移・停滞・期限接近の評価を定期実行し、条件成立でアラートを送る。DM 失敗時はチャンネルにフォールバック。

## Scope
- **In**: 週次チェックイン通知スケジュール(`this.schedule()` cron、初期 金曜16:30)、通知文(現在の状態件数付き §9.1)、Red/Yellow アラート判定・送信(§9.3)、停滞/期限接近の検出、送信失敗フォールバック。
- **Out**: ステータス判定ロジック本体(status-and-draft を呼ぶ)、`/checkin` の会話・分類(checkin-classification)、Google Calendar 連携・`/prepare 1on1`(MVP 対象外、将来枠)、送信ヘルパーの実装(discord-gateway)。

## Boundary Candidates
- 週次チェックインスケジューラ(cron 設定・配信)
- アラート判定エンジン(状態遷移・停滞・期限トリガ)
- 通知文組み立て + 配信(送信ヘルパー利用)

## Out of Boundary
- ステータス判定そのもの(status-and-draft)
- 分類・証跡化(checkin-classification)
- カレンダー連携・1on1 前通知(Phase 3)

## Upstream / Downstream
- **Upstream**: infra-foundation, discord-gateway, status-and-draft
- **Downstream**: なし(MVP の最終ウェーブ)。将来の Calendar 連携(Phase 3)が拡張する。

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: status-and-draft(判定結果の取得)、discord-gateway(送信)、checkin-classification(通知が `/checkin` フローへ誘導)

## Constraints
- `this.schedule()` は分粒度 cron(週次通知に十分)。タスクは DO 内 SQLite に永続化・冪等。
- 初期スケジュールは毎週金曜 16:30(設定変更可能性は design で検討)。
- プロアクティブ DM はギルド共有/DM 許可前提、403 時チャンネルフォールバック(§15: DM/非公開チャンネル限定)。
- アラートトリガは §9.3 準拠。半期終了日は evaluation_cycles.end_date から算出。
