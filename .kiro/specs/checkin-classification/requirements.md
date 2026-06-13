# Requirements Document

## Project Description (Input)
本プロジェクトの中心仮説は「毎週聞いてくれるチャット Agent なら継続する」であり、その核心が、ユーザーの雑な週次入力を各評価目標に自動分類し、確認の上で証跡化するフローである。これが無ければ製品価値が成立しない。

infra-foundation(LLM クライアント・スキーマ)、discord-gateway(deferred/button)、goal-management(目標定義・証跡保存)が揃っており、本スペックは未実装の分類ロジックと `/checkin` フローを所有する。

- `/checkin` が「今週やったことを雑に書いてください」と促し、ユーザーの自然文返信を受け取る。
- Workers AI が入力を分解し、各項目を候補目標に関連度スコア付きで分類する(§13.1 の JSON 出力形式)。
- 分類案を Discord に提示し、[保存]/[修正]/[破棄] ボタンで確定する(自動確定しない)。
- 保存後、証跡(evidence)と evidence_goal_links が作成され、週次レビュー(summary/risks/next_actions)が生成・提示される。

出典仕様: goal-agent-spec.md §8.3(`/checkin` フロー)、§13.1(分類 LLM 出力 JSON)、§11.4 checkins / §11.5 evidence / §11.6 evidence_goal_links / §11.7 weekly_reviews(スキーマ)、§14.1/§14.2(メッセージ UX)、§15(プライバシー: 自動確定禁止・保存前確認必須)。

## Boundary Context

- **In scope**:
  - `/checkin` 会話フロー(分類対象入力の促し → 自然文返信の受領)。
  - 雑入力の構造化分類(項目分解・候補目標への関連度スコア・usefulness・推奨証跡タイトル)を Workers AI で取得し、§13.1 の出力形式に準拠して解釈する。
  - 分類案の確認メッセージ提示(§14.1)と [保存]/[修正]/[破棄] ボタンによる確定処理。
  - 保存確定時の証跡(evidence)・evidence_goal_links 作成。
  - 保存後の週次レビュー(summary/risks/next_actions)生成と提示(§14.2)。
- **Out of scope**:
  - 評価サイクル/目標/証跡の定義 CRUD(goal-management 所有)。
  - ステータス Green/Yellow/Red の判定ルールそのもの(status-and-draft 所有。保存後メッセージで見立てを参照する程度)。
  - 評価文ドラフト生成(status-and-draft 所有)。
  - 定期チェックイン通知・アラートのスケジューリング(notifications 所有。本フローを起動する側)。
  - 永続化スキーマ DDL・Agent クラス骨格・LLM クライアント実装(infra-foundation 所有)。
  - Discord 署名検証・ディスパッチ・応答プロトコル・コマンド登録手段(discord-gateway 所有)。
- **Adjacent expectations**:
  - discord-gateway から、deferred 応答(3秒以内)+ follow-up、ボタンへの interaction ディスパッチ、実行ユーザー ID を含む文脈供給、ephemeral 応答手段を消費する。
  - infra-foundation から、サイクル単位の永続化(checkins/evidence/evidence_goal_links/weekly_reviews 行アクセス)、Agent ルーティング、差し替え可能な LLM クライアントを消費する。
  - goal-management が保存した「サイクル定義」「目標一覧 + 達成条件」を分類コンテキストとして取得する。
  - status-and-draft が提供するステータス見立て(保存後メッセージ用)に依存しうるが、本スペックは判定ルールを所有しない。

## Requirements

### Requirement 1: `/checkin` 会話開始と入力受領
**Objective:** 半期評価目標を持つ個人ユーザーとして、週次の雑なメモを書く起点が欲しい。これにより、分類対象となる自然文を負担なく Agent に渡せる。

#### Acceptance Criteria
1. When ユーザーが `/checkin` を実行する, the Checkin Service shall 「今週やったことを雑に書いてください。評価目標に関係あるかどうかはこちらで分類します。」に相当する促しメッセージを返す。
2. While ユーザーが所有するアクティブな評価サイクルが存在しない, when ユーザーが `/checkin` を実行する, the Checkin Service shall サイクル未作成である旨と先にサイクル/目標を用意する案内を返し、分類フローを開始しない。
3. When ユーザーが促しに対して自然文の週次入力を返信する, the Checkin Service shall その raw テキストを分類処理の対象として受け取る。
4. If ユーザーの週次入力が空または空白のみである, then the Checkin Service shall 分類を実行せず、入力が必要である旨をユーザーに通知する。
5. The Checkin Service shall `/checkin` の一連の入出力を、実行ユーザー本人のみが閲覧できる文脈(ephemeral または DM/個人用非公開チャンネル)に限定する。

### Requirement 2: 雑入力の構造化分類
**Objective:** ユーザーとして、雑に書いたメモを各評価目標へ自動で振り分けてほしい。これにより、手動で分類する手間なく証跡化できる。

#### Acceptance Criteria
1. When 週次入力を受け取る, the Checkin Service shall 実行ユーザーの目標一覧と各目標の達成条件を分類コンテキストとして取得する。
2. When 分類を実行する, the Checkin Service shall 入力を複数の項目(text)に分解し、各項目に対して候補目標を関連度スコア(0〜1)・関連理由付きで対応付ける。
3. When 分類を実行する, the Checkin Service shall 各項目に有用度(usefulness: low/medium/high)と推奨証跡タイトル(suggestedEvidenceTitle)を付与する。
4. The Checkin Service shall 分類結果を、項目配列とその候補目標(goalId・relevanceScore・reason)・usefulness・suggestedEvidenceTitle を含む構造化形式(§13.1 準拠)として表現する。
5. If いずれの目標にも十分関連しない項目がある, then the Checkin Service shall その項目を「未分類」として保持し、破棄せずユーザーに提示する。
6. If 分類処理の応答が構造化形式として解釈できない, then the Checkin Service shall ユーザーに分類失敗である旨と再試行可能であることを通知し、誤った証跡を保存しない。
7. While 分類処理に時間を要する, the Checkin Service shall 3秒以内に処理中である旨の応答を返し、分類完了後に結果を追って提示する。

### Requirement 3: 分類確認メッセージと確定ボタン
**Objective:** ユーザーとして、保存前に分類案を確認し、保存・修正・破棄を選びたい。これにより、誤分類のまま証跡が残ることを防げる。

#### Acceptance Criteria
1. When 分類が完了する, the Checkin Service shall 目標ごとにグルーピングした項目一覧と未分類項目を含む確認メッセージ(§14.1 準拠)を提示する。
2. When 確認メッセージを提示する, the Checkin Service shall [保存]・[修正]・[破棄] の操作ボタンを併せて提示する。
3. The Checkin Service shall 分類結果を、ユーザーが [保存] を選択するまで証跡として確定しない。
4. When ユーザーが [破棄] を選択する, the Checkin Service shall 分類結果を証跡化せず破棄し、破棄した旨を通知する。
5. When ユーザーが [修正] を選択する, the Checkin Service shall ユーザーが分類内容を修正できる手段を提示し、修正後の内容を保存対象とする。
6. The Checkin Service shall 確認メッセージおよびボタン操作の応答を、実行ユーザー本人のみが閲覧できる文脈に限定する。
7. If 確認対象の分類結果が見つからない、または操作したユーザーが分類を開始したユーザーと一致しない, then the Checkin Service shall 証跡を保存せず、操作できない旨を通知する。

### Requirement 4: 証跡と目標リンクの保存
**Objective:** ユーザーとして、確認した分類案を証跡として蓄積したい。これにより、後続のステータス判定や評価文生成の材料になる。

#### Acceptance Criteria
1. When ユーザーが分類案の [保存] を選択する, the Checkin Service shall 週次入力の raw テキストをチェックイン(checkins)として、対象サイクル・実行ユーザー・週開始日とともに保存する。
2. When 保存を実行する, the Checkin Service shall 各分類項目を証跡(evidence)として、source_type を手動チェックイン由来・本文・証跡日・usefulness・推奨タイトルとともに作成する。
3. When 証跡を作成する, the Checkin Service shall その証跡と候補目標の対応を evidence_goal_links として、関連度スコアと関連理由付きで作成する。
4. The Checkin Service shall 保存する全レコード(checkins/evidence/evidence_goal_links)に実行ユーザーの所有者識別子を付与し、他ユーザーのデータと混在させない。
5. While 1つの証跡が複数の目標に関連する, when 保存を実行する, the Checkin Service shall 各目標ごとに evidence_goal_links を作成する。
6. If 保存処理が完了できない, then the Checkin Service shall 保存に失敗した旨をユーザーに通知し、部分的に不整合なレコードを残さない。

### Requirement 5: 保存後の週次レビュー生成
**Objective:** ユーザーとして、保存後にその週の見立てと次アクションを受け取りたい。これにより、毎週の振り返りと次の一手が明確になる。

#### Acceptance Criteria
1. When 証跡の保存が完了する, the Checkin Service shall 当該週の週次レビュー(summary・risks・next_actions)を生成する。
2. When 週次レビューを生成する, the Checkin Service shall それを週次レビュー(weekly_reviews)として、対象サイクル・実行ユーザー・週開始日・サマリとともに保存する。
3. When 週次レビューの生成が完了する, the Checkin Service shall 保存完了の旨・当該週の見立て・来週やるとよいことを含む保存後メッセージ(§14.2 準拠)をユーザーに提示する。
4. Where ステータスの見立てを保存後メッセージに含める, the Checkin Service shall 判定ルールを自前で定義せず、status-and-draft が提供する見立てを参照する。
5. If 週次レビューの生成が失敗する, then the Checkin Service shall 証跡の保存自体は確定済みとして保持しつつ、レビュー生成に失敗した旨をユーザーに通知する。

### Requirement 6: プライバシーと境界の遵守
**Objective:** ユーザーおよび運用者として、評価データの機微性が守られ、本機能が他スペックの責務を侵さないことを保証したい。これにより、安全に運用でき、各スペックを独立して保守できる。

#### Acceptance Criteria
1. The Checkin Service shall 自動分類結果を、ユーザーの明示的な [保存] 操作なしに証跡として確定しない(§15 必須)。
2. The Checkin Service shall 個人の評価データを含む全応答を、実行ユーザー本人のみが閲覧できる文脈(ephemeral または DM/個人用非公開チャンネル)に限定する(§15 必須)。
3. The Checkin Service shall 全データアクセスを実行ユーザーの所有スコープに限定し、他ユーザーの目標・証跡・チェックインへアクセスしない(§15 必須)。
4. The Checkin Service shall 永続化スキーマ・Agent クラス骨格・LLM クライアント実装・Discord I/O 規約を再定義せず、infra-foundation と discord-gateway の公開契約を消費する。
5. The Checkin Service shall 評価サイクル/目標/証跡の定義 CRUD・ステータス判定ルール・評価文ドラフト生成・通知スケジューリングを所有せず、それぞれを所有するスペックの責務として扱う。
6. Where LLM 分類の日本語品質が不足する, the Checkin Service shall プロンプト/構造化出力のみを所有し、プロバイダ/モデル差し替えは infra-foundation の LLM 抽象化レイヤに委ねる。
