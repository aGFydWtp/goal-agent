# Implementation Plan

> 依存方向: `commands.ts`・`custom-ids.ts` → `register.ts` → `handlers/*` → `domain/checkin-operations.ts` → infra `Repository`/`LlmClient` & goal-management `listGoals/getGoal`。`classification/*`・`weekly-review/*`・`messages.ts` は domain から参照される横断ヘルパー。上流(infra-foundation / discord-gateway / goal-management)の公開契約は再定義せず消費する。

- [x] 1. Foundation: コマンド定義・custom_id 規約・横断ヘルパーの確立
- [x] 1.1 `/checkin` コマンド定義と custom_id 規約を定義する
  - `/checkin` の application command 定義(引数なし)を作成する
  - checkin modal の custom_id(`CHECKIN_MODAL_ID`)、[入力する]/[保存]/[修正]/[破棄] ボタンの custom_id 規約を定義し、保存/修正/破棄ボタンには pending 識別子を埋め込む/抽出するユーティリティを用意する
  - 完了状態: コマンド定義オブジェクトと custom_id の組立・分解関数が型付きで提供され、pendingId の往復(埋め込み→抽出)が一致する
  - _Requirements: 1.1, 3.2, 3.7_
  - _Boundary: Command Definitions, custom-ids_

- [x] 1.2 (P) 分類の構造化出力スキーマと検証を実装する
  - §13.1 準拠の分類結果型(items[].text / candidateGoals[].goalId・relevanceScore・reason / usefulness / suggestedEvidenceTitle)を定義する(infra の共有基本型 `Usefulness`/`RelevanceScore` を組み合わせる)
  - `completeJson` 戻り値の構造・型・値域(relevanceScore 0..1、usefulness 列挙、goalId が実在目標集合に含まれる)を検証し、候補目標が無い項目を未分類として保持する検証関数を実装する
  - 空/空白のみ入力を分類前に弾く空入力ガードを実装する
  - 完了状態: 正常入力で検証成功・未分類項目を保持、値域外/非実在 goalId/JSON 不整合/空入力でそれぞれ判別可能な失敗理由を返すユニットテストが通る
  - _Requirements: 1.4, 2.4, 2.5, 2.6_
  - _Boundary: Classification Prompt Schema Verify_

- [x] 1.3 (P) 分類プロンプトと週次レビュープロンプトを実装する
  - 目標一覧(id/title/description/success_criteria)とユーザー入力から §13.1 入力(目標 + 達成条件 + 今週の入力)を反映した分類プロンプトを組み立てる
  - 保存済み内容から summary/risks/next_actions を生成する週次レビュープロンプトと出力検証を実装する
  - 完了状態: 与えた目標と入力がプロンプト本文に反映され、週次レビュープロンプトが summary/risks/next_actions を要求する構造になっていることをユニットテストで確認できる
  - _Requirements: 2.1, 2.2, 5.1_
  - _Boundary: Classification Prompt Schema Verify, Weekly Review Prompt_

- [x] 1.4 (P) メッセージ整形ヘルパーを実装する
  - §8.3 の促し文を返す整形を実装する
  - 分類結果を §14.1 形式(目標ごとグルーピング + 未分類セクション + 保存しますか?)へ整形する
  - 週次レビューを §14.2 形式(保存完了 + 見立て + 来週やるとよいこと)へ整形し、ステータス見立ては与えられた時のみ含め未指定時は省略する
  - 完了状態: 促し文・確認メッセージ・保存後メッセージが仕様 §8.3/§14.1/§14.2 の構造で生成され、見立てあり/なし両方の保存後メッセージをユニットテストで確認できる
  - _Requirements: 1.1, 2.5, 3.1, 5.3, 5.4_
  - _Boundary: Message Formatter_

- [ ] 2. Core: チェックインドメインメソッド(分類・証跡化・週次レビュー・pending 保持)
- [x] 2.1 アクティブサイクル特定と pending 分類保持を実装する
  - 実行ユーザーの最新サイクルを特定し、無ければ未作成として扱うドメインメソッドを実装する(goal-management の対象サイクル決定規約に従う)
  - 分類完了から確定操作までの分類結果を pendingId 採番で Agent インスタンスに揮発保持し、userId に紐付ける。取得・破棄を実装する
  - 完了状態: サイクル有り/無しを判別でき、pending が pendingId で保持・取得・破棄でき、別 userId からの取得が不存在として扱われる
  - _Requirements: 1.2, 3.3, 3.4, 3.7_
  - _Boundary: Checkin Domain Operations_
  - _Depends: 1.1_

- [x] 2.2 分類実行ドメインメソッドを実装する
  - goal-management の目標一覧取得で目標 + 達成条件を取得し、分類プロンプト → `LlmClient.completeJson` → 検証 を順に呼ぶ
  - 検証成功で pending 保持して結果を返し、`invalid_output`/検証失敗を分類失敗として返す(証跡は作らない)
  - 完了状態: 正常時に項目分解 + 候補目標(関連度スコア/理由)+ usefulness + 推奨タイトルを含む結果が返り pending が保持される、分類失敗時は失敗理由が返り何も永続化されないことを確認できる
  - _Requirements: 2.1, 2.2, 2.3, 2.6_
  - _Boundary: Checkin Domain Operations_
  - _Depends: 1.2, 1.3, 2.1_

- [ ] 2.3 証跡化(保存)ドメインメソッドを実装する
  - pendingId と所有者を検証(不在/別人は not_found)し、チェックインを raw テキスト・対象サイクル・実行ユーザー・週開始日とともに保存する
  - 各分類項目を証跡(source_type=手動チェックイン由来・本文=項目テキスト・推奨タイトル・usefulness・証跡日)として作成し、各候補目標ごとに目標リンク(関連度スコア/理由)を作成する。全レコードに所有者識別子を付与する
  - 単一権威上で一括処理し、部分失敗時に不整合レコードを残さず保存完了で pending を破棄する
  - 完了状態: 1 つの証跡が複数目標に関連する場合に複数リンクが作られ、保存後に checkins/evidence/evidence_goal_links が所有者スコープで揃い、別人/不在 pending で not_found・保存失敗で不整合なしを確認できる
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - _Boundary: Checkin Domain Operations_
  - _Depends: 2.1, 2.2_

- [ ] 2.4 週次レビュー生成ドメインメソッドを実装する
  - 保存済み内容から週次レビュープロンプトで summary/risks/next_actions を生成し、対象サイクル・実行ユーザー・週開始日・サマリとともに保存する
  - 生成失敗時は証跡保存を確定済みとして保持しつつレビュー失敗を返す
  - 完了状態: 保存後に当該週の週次レビューが永続化され、LLM 生成失敗時も既存の証跡が保持されレビュー失敗のみが返ることを確認できる
  - _Requirements: 5.1, 5.2, 5.5_
  - _Boundary: Checkin Domain Operations_
  - _Depends: 1.3, 2.3_

- [ ] 3. Core: `/checkin` ハンドラ群
- [ ] 3.1 (P) `/checkin` コマンドハンドラと [入力する] ボタンハンドラを実装する
  - `/checkin` で対象サイクル有無を確認し、有りで促し文 + [入力する] ボタンを ephemeral 即時応答、無しでサイクル未作成案内を返し分類フローを開始しない
  - [入力する] ボタンで複数行 TextInput を持つ checkin modal を開く応答を返す
  - 完了状態: サイクル有りで促し + ボタンが ephemeral 表示され、無しで案内のみ、[入力する] で modal が開くことを確認できる
  - _Requirements: 1.1, 1.2, 1.3, 1.5_
  - _Boundary: Checkin Command Handler, Input Button Handler_
  - _Depends: 1.1, 1.4, 2.1_

- [ ] 3.2 (P) checkin modal submit ハンドラ(分類 = deferred)を実装する
  - 空入力ガードを通し、空なら ephemeral 通知。入力ありなら 3秒以内に deferred(ephemeral)応答を返し、分類を後処理で実行する
  - 分類成功で確認メッセージ(§14.1)と保存/修正/破棄ボタン(custom_id に pendingId)を follow-up し、失敗で再試行案内を follow-up する
  - 完了状態: 入力ありで type5 が即返され follow-up に確認メッセージ + 3 ボタンが届く、空入力で ephemeral 通知、分類失敗で再試行案内が届き証跡が作られないことを確認できる
  - _Requirements: 1.3, 1.4, 2.6, 2.7, 3.1, 3.2, 3.6_
  - _Boundary: Checkin Modal Submit Handler_
  - _Depends: 1.1, 1.4, 2.2_

- [ ] 3.3 (P) 保存・修正・破棄ボタンハンドラを実装する
  - [保存] で証跡化ドメインメソッドを呼び、続けて週次レビュー生成を呼んで保存後メッセージ(§14.2)を ephemeral 応答する。pending 不在/別人で操作不可を通知。レビュー失敗時は保存完了 + レビュー失敗を通知
  - [破棄] で pending を破棄し破棄通知、[修正] で分類内容を編集できる modal を再提示する
  - 完了状態: [保存] で証跡 + 週次レビューが作られ §14.2 メッセージが ephemeral 表示、[破棄] で確定されず通知、[修正] で編集 modal 提示、不在/別人 pending で操作不可を確認できる
  - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 5.3, 5.4_
  - _Boundary: Save Edit Discard Button Handlers_
  - _Depends: 1.1, 1.4, 2.3, 2.4_

- [ ] 4. Integration: ハンドラ登録とコマンド定義の配線
- [ ] 4.1 ハンドラ登録とコマンド定義集約点への追加を実装する
  - `/checkin` コマンド・[入力する]/[保存]/[修正]/[破棄] ボタン・checkin modal submit の各ハンドラを discord-gateway のレジストリへ規約適合で登録する
  - `/checkin` のコマンド定義を discord-gateway のコマンド定義集約点へ追加する(配列追加のみ、機構は変更しない)
  - EvaluationCycleAgent 骨格が宣言する分類/証跡化/週次レビュー/pending 保持の責務メソッドの中身を本スペックのドメイン実装で埋める(クラス宣言・onStart は変更しない)
  - 完了状態: 登録後に `(command,'checkin')`・各 custom_id・modal が対応ハンドラへ解決され、コマンド登録対象に `/checkin` が含まれることを確認できる
  - _Requirements: 1.1, 6.4_
  - _Boundary: Command Definitions, Register, Checkin Domain Operations_
  - _Depends: 3.1, 3.2, 3.3_

- [ ] 5. Validation: 結合・E2E テスト
- [ ] 5.1 分類フローの結合テストを実装する
  - `/checkin` → [入力する] → modal → 分類(deferred)の経路で、サイクル有無分岐・空入力通知・分類成功時の確認メッセージ + 3 ボタン follow-up・分類失敗時の再試行案内(証跡非作成)を検証する
  - 未分類項目が確認メッセージに保持されることを検証する
  - 完了状態: 上記分岐がモック LLM/ゲートウェイで再現され、確認メッセージ・未分類保持・分類失敗時の非保存が結合テストで通る
  - _Requirements: 1.2, 1.3, 1.4, 2.5, 2.6, 2.7, 3.1, 3.2_
  - _Depends: 4.1_

- [ ] 5.2 保存・週次レビュー・破棄/修正の結合テストを実装する
  - [保存] で checkins/evidence/evidence_goal_links が所有者スコープで作成され(複数目標で複数リンク)、週次レビューが保存され §14.2 メッセージが返ることを検証する
  - レビュー生成失敗時も証跡保存が保持されること、[破棄]/[修正] の挙動、別人/不在 pending での非保存を検証する
  - 完了状態: 保存・レビュー・破棄・修正・所有者スコープ・部分失敗非残存の各シナリオが結合テストで通る
  - _Requirements: 3.3, 3.4, 3.5, 3.7, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.5_
  - _Depends: 4.1_

- [ ] 5.3 プライバシー・境界の E2E/スモークテストを実装する
  - サイクル + 目標登録済みから `/checkin` → modal 入力 → 分類 → [保存] → 保存後メッセージまで通し、証跡・リンク・週次レビューが単一権威に揃う critical path を検証する
  - 全応答が ephemeral(本人限定)であること、自動分類が [保存] なしに確定しないこと、他ユーザーデータへアクセスしないこと、スキーマ/Agent/LLM/Discord 規約を再定義せず上流契約を消費していることを確認する
  - 完了状態: critical path が通り、保存前確認・ephemeral 限定・所有者スコープ・上流契約消費の各プライバシー/境界要件がスモークテストで確認できる
  - _Requirements: 1.5, 3.6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
  - _Depends: 4.1_
