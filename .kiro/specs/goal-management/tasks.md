# Implementation Plan

- [ ] 1. Foundation: 横断ヘルパーとコマンド定義の整備
- [ ] 1.1 入力検証ヘルパーを実装
  - サイクルの開始日/終了日の日付パースと期間整合(終了が開始より前でないこと)を検証する処理を実装する
  - 目標の必須項目(目標名・目標本文)の有無を検証し、不足項目を判別可能に返す処理を実装する
  - 完了状態: 不正日付で `invalid_date`、終了<開始で `end_before_start`、正常で `ok` を返し、必須欠落時に不足項目名を返すユニットテストが通る
  - _Requirements: 1.4, 2.5_
  - _Boundary: Input Validation_

- [ ] 1.2 (P) 所有者スコープ強制ヘルパーを実装
  - Repository から取得した行に対し、実行ユーザーの所有者識別子(user_id)一致を検証し、不一致なら不存在(null)として扱うヘルパーを実装する
  - 完了状態: user_id 一致時は行を返し、不一致時は null を返す(他ユーザーデータの存在を露出しない)ユニットテストが通る
  - _Requirements: 4.1, 4.2, 3.4_
  - _Boundary: Ownership Scope Helper_

- [ ] 1.3 (P) コマンド定義を作成
  - `/cycle create`(name/start/end オプション)・`/goal add`・`/evidence delete`(id オプション)の application command 定義を作成する
  - goal 入力 modal の custom_id 規約(GOAL_MODAL_ID と各フィールド custom_id)を定義する
  - 完了状態: 3 コマンドの定義と modal/フィールドの custom_id 規約が型付きで公開され、後段の登録処理から参照できる
  - _Requirements: 1.1, 2.1, 3.1_
  - _Boundary: Command Definitions + Register_
  - _Depends: 1.1_

- [ ] 2. Core: ドメイン CRUD ビジネスロジック
- [ ] 2.1 サイクル作成ドメインロジックを実装(EvaluationCycleAgent メソッド)
  - 実行ユーザーを所有者として付与し、同一ユーザー内の同名サイクル重複を検出してから Repository へ永続化する処理を、EvaluationCycleAgent の骨格メソッドの実体として実装する
  - 完了状態: 重複なしで `evaluation_cycles` 行が user_id 付きで insert され、同名重複で `duplicate` を返すユニットテストが通る
  - _Requirements: 1.2, 1.5, 4.3, 5.3, 5.4_
  - _Boundary: Cycle Domain Operations_
  - _Depends: 1.2_

- [ ] 2.2 目標登録ドメインロジックを実装(EvaluationCycleAgent メソッド)
  - 対象サイクル(実行ユーザー所有の最新サイクル)の存在を検証し、目標名・本文・達成条件(複数行)・評価観点(複数行)・期限を初期ステータス gray で Repository へ永続化する処理を実装する
  - 対象サイクルが存在しない場合は `no_cycle` を返す
  - 完了状態: サイクル存在時に `goals` 行が status='gray'・複数行の達成条件/評価観点付きで insert され、サイクル不存在時に `no_cycle` を返すユニットテストが通る
  - _Requirements: 2.2, 2.4, 2.6, 2.8, 4.3, 5.3, 5.4_
  - _Boundary: Cycle Domain Operations_
  - _Depends: 1.2, 2.1_

- [ ] 2.3 目標一覧/取得ドメインロジックを実装
  - 1 サイクルに属する目標一覧の取得と、特定目標の定義(目標名・本文・達成条件・評価観点・期限・ステータス)取得を所有者スコープ内で行う処理を、EvaluationCycleAgent(一覧/取得)と GoalAgent(親への委譲)に実装する
  - 完了状態: 所有者スコープ内で同一サイクルの目標一覧と各目標定義が取得でき、非所有データは取得対象外になることをユニットテストで確認できる
  - _Requirements: 5.1, 5.2, 5.3, 2.3_
  - _Boundary: Cycle Domain Operations, Goal Domain Operations_
  - _Depends: 1.2, 2.2_

- [ ] 2.4 証跡削除ドメインロジックを実装(EvaluationCycleAgent メソッド)
  - 指定証跡の所有者一致を検証し、不一致・不存在を `not_found` に正規化したうえで、紐づく証跡-目標リンクを連動削除してから証跡本体を削除する処理を実装する
  - 完了状態: 所有証跡が evidence_goal_links ごと削除され、不存在・非所有でいずれも `not_found` を返す(露出しない)ユニットテストが通る
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 5.3, 5.4_
  - _Boundary: Cycle Domain Operations_
  - _Depends: 1.2_

- [ ] 3. Core: コマンド/modal/button ハンドラ
- [ ] 3.1 `/cycle create` ハンドラを実装
  - InteractionContext から実行ユーザー・name/start/end を取り、期間検証→サイクル作成ドメイン呼び出し→結果整形を行う
  - 検証 NG・重複時は ephemeral エラー応答、成功時はサイクル名と期間を含む ephemeral 確認応答を返す
  - 完了状態: 正常入力でサイクルが作成され ephemeral 確認応答、不正期間/同名重複で ephemeral エラー応答が返ることを確認できる
  - _Requirements: 1.1, 1.3, 1.4, 1.6, 4.4_
  - _Boundary: Cycle Create Handler_
  - _Depends: 1.1, 2.1_

- [ ] 3.2 (P) `/goal add` ハンドラ(modal 提示)を実装
  - `/goal add` コマンドに対し、目標名・本文・達成条件・評価観点・期限のフィールドを持つ modal を開く応答を返す
  - 完了状態: `/goal add` 実行で定義済み custom_id を持つ目標入力 modal 応答が返ることを確認できる
  - _Requirements: 2.1_
  - _Boundary: Goal Add / Modal Submit Handlers_
  - _Depends: 1.3_

- [ ] 3.3 goal modal submit ハンドラを実装
  - modal 送信の各フィールド値を取り出し、必須検証→目標登録ドメイン呼び出し→GoalAgent 確立→結果整形を行う
  - 必須欠落は不足項目を示す ephemeral 応答、対象サイクル無しは先にサイクル作成が必要な旨の ephemeral 応答、成功時は目標名を含む ephemeral 確認応答を返す
  - 完了状態: 正常 submit で目標が保存され GoalAgent が確立し ephemeral 確認応答、必須欠落/サイクル無しで各エラー応答が返ることを確認できる
  - _Requirements: 2.2, 2.3, 2.5, 2.6, 2.7, 4.4_
  - _Boundary: Goal Add / Modal Submit Handlers_
  - _Depends: 1.1, 2.2, 2.3, 3.2_

- [ ] 3.4 (P) `/evidence delete` ハンドラを実装
  - InteractionContext から実行ユーザー・証跡 ID を取り、証跡削除ドメイン呼び出し→結果整形を行う
  - 不存在・非所有は「見つからない」ephemeral 応答(露出しない)、成功時は削除完了の ephemeral 応答を返す
  - 完了状態: 所有証跡の削除で ephemeral 削除完了応答、不存在/非所有で「見つからない」ephemeral 応答が返ることを確認できる
  - _Requirements: 3.1, 3.3, 3.4, 3.5, 4.4_
  - _Boundary: Evidence Delete Handler_
  - _Depends: 2.4_

- [ ] 4. Integration: ハンドラ登録とコマンド定義集約
- [ ] 4.1 ハンドラ登録とコマンド定義を discord-gateway へ統合
  - cycle create / goal add(command)・goal modal(modal)・evidence delete(command)の各ハンドラを discord-gateway のレジストリへ識別子(コマンド名/custom_id)で登録する
  - goal-management のコマンド定義を discord-gateway のコマンド定義集約点へ追加する(ゲートウェイの登録機構は変更しない)
  - 完了状態: 4 ハンドラがレジストリに登録され、3 コマンド定義が集約点に含まれ、ディスパッチャから各ハンドラへ振り分けられることを確認できる
  - _Requirements: 1.1, 2.1, 3.1, 6.4_
  - _Boundary: Command Definitions + Register, Cycle Create Handler, Goal Add / Modal Submit Handlers, Evidence Delete Handler_
  - _Depends: 3.1, 3.2, 3.3, 3.4_

- [ ] 5. Validation: 統合テストと境界検証
- [ ] 5.1 サイクル/目標登録の統合テスト
  - `/cycle create` で EvaluationCycleAgent が確立されサイクルが永続化され ephemeral 確認応答が返ること、`/goal add`→modal submit で目標が対象サイクルに保存され GoalAgent が確立されることを検証する
  - `/cycle create`→複数 `/goal add`→目標一覧取得で登録目標が単一権威に揃うことを検証する
  - 完了状態: 上記サイクル作成・目標登録・一覧取得の統合テストが通る
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.7, 5.1, 5.3_
  - _Depends: 4.1_

- [ ] 5.2 証跡削除と所有者スコープの境界テスト
  - `/evidence delete` で所有証跡がリンクごと削除され削除確認が返ること、非所有/不存在で「見つからない」応答になり他ユーザーデータが露出しないことを検証する
  - 他ユーザー所有のサイクル/目標/証跡を対象とする操作が不存在として扱われることを検証する
  - 完了状態: 証跡削除の正常/非所有/不存在パスと、サイクル/目標/証跡の所有者スコープ越境拒否の統合テストが通る
  - _Requirements: 3.1, 3.2, 3.4, 3.5, 4.1, 4.2, 4.4_
  - _Depends: 4.1_
