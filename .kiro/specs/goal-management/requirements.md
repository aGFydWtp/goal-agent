# Requirements Document

## Introduction
本スペック「goal-management」は、評価目標フォロー Agent における「評価サイクル・目標・証跡の定義 CRUD」を定義する。半期サイクルの作成、複数の評価目標の登録(modal 入力)、証跡定義の安全な削除、および所有者スコープのアクセス制御を、エンドユーザーが Discord 上で観測できる契約として確立する。これにより、後続スペック(checkin-classification による分類・証跡化、status-and-draft によるステータス判定・評価文ドラフト)が参照すべき「定義済みのサイクル・目標・証跡」という対象を提供する。

利用者は半期評価目標を複数持つ個人であり、`/cycle create` で半期サイクルを作成し、`/goal add` の modal で目標定義(目標名・本文・達成条件・評価観点・期限)を登録し、`/evidence delete` で個人の証跡を安全に削除する。本スペックは上流の infra-foundation が確立した永続化スキーマ(仕様書 §11)・Agent トポロジ(EvaluationCycleAgent をデータ権威、目標単位の GoalAgent)・共有ドメイン型を再定義せず消費し、discord-gateway が確立した interaction ディスパッチ規約・deferred/follow-up パターン・ephemeral 応答・送信ヘルパーに従ってコマンド処理を実装する。プライバシー要件(仕様書 §15: 他ユーザーデータ不可、保存前確認、削除コマンド必須、DM/個人用非公開チャンネル限定)を満たす。

分類・ステータス判定・ドラフト生成は本スペックのスコープ外であり、定義の CRUD と所有者スコープ制御のみを所有する。

## Boundary Context
- **In scope**: `/cycle create`(名前・開始日・終了日でサイクルを作成し EvaluationCycleAgent を確立)、`/goal add`(modal を起動し、目標名・本文・達成条件・評価観点・期限を受けて目標定義を保存、対応する GoalAgent を確立)、`/evidence delete`(証跡 ID 指定で所有者の証跡を削除)、サイクル/目標/証跡定義の保存・取得・削除、所有者スコープのアクセス制御(実行ユーザーが所有しないデータへの作成・取得・削除を拒否)、EvaluationCycleAgent/GoalAgent の定義状態管理(目標一覧の保持、目標定義の保持)。
- **Out of scope**: 雑入力の目標分類・証跡の自動生成(checkin-classification が所有)、ステータス判定・評価文ドラフト生成・`/status`・`/goal status`・`/draft`(status-and-draft が所有)、`/checkin` フロー(checkin-classification が所有)、`/evidence list` の一覧表示(status-and-draft 側で扱う。本スペックは削除のみ)、定期通知・アラート(notifications が所有)、`/goal edit`・`/cycle archive`(MVP 任意。本スペックでは扱わない)、Discord 署名検証・interaction ディスパッチ・応答プロトコル・コマンド登録手段(discord-gateway が所有)、永続化スキーマ DDL・Agent クラス骨格・LLM クライアント(infra-foundation が所有)。
- **Adjacent expectations**: 本スペックは discord-gateway が定める interaction ハンドラ登録規約・`InteractionContext`(実行ユーザー ID を含む)・modal/button ルーティング・deferred + follow-up・ephemeral 応答手段を利用し、署名検証や Discord 応答プロトコルを再実装しない。`/cycle create` と `/goal add` のコマンド定義および modal 定義は本スペックが供給し、discord-gateway の登録手段(コマンド定義集約点)へ追加する。データの読み書きは infra-foundation の Agent ルーティングヘルパー(`getCycleAgent`/`getGoalAgent`)と権威リポジトリを経由する。後続の checkin-classification は本スペックが保存した目標一覧・達成条件を参照し、status-and-draft は目標定義・証跡を参照することを前提とする。

## Requirements

### Requirement 1: 評価サイクルの作成
**Objective:** As a 半期評価目標を持つ個人ユーザー, I want `/cycle create` で名前・期間を指定して半期サイクルを作成すること, so that 目標と証跡を紐づける半期の枠を確立できる

#### Acceptance Criteria
1. When ユーザーが `/cycle create` をサイクル名・開始日・終了日とともに実行する, the goal-management サービス shall 実行ユーザーを所有者とする評価サイクル定義を作成し永続化する。
2. When サイクルが作成される, the goal-management サービス shall 作成されたサイクルのデータ権威となる EvaluationCycleAgent を実行ユーザーと当該サイクルに対して確立する。
3. When サイクルの作成が成功する, the goal-management サービス shall サイクル名と期間(開始日〜終了日)を含む確認応答を実行ユーザーに返す。
4. If 開始日または終了日が日付として解釈できない、あるいは終了日が開始日より前である, then the goal-management サービス shall サイクルを作成せず、入力の不備を示すエラー応答を返す。
5. If 同一ユーザーが同名のサイクルを重複して作成しようとする, then the goal-management サービス shall 重複を検出し、既存サイクルがある旨を示す応答を返して重複作成を行わない。
6. The goal-management サービス shall サイクル作成の応答を実行ユーザー本人にのみ可視となる形(ephemeral または DM/個人用非公開チャンネル文脈)で返す。

### Requirement 2: 評価目標の登録(modal 入力)
**Objective:** As a 半期評価目標を持つ個人ユーザー, I want `/goal add` で目標名・本文・達成条件・評価観点・期限を入力して目標を登録すること, so that 評価対象の目標定義を構造化して保存できる

#### Acceptance Criteria
1. When ユーザーが `/goal add` を実行する, the goal-management サービス shall 目標名・目標本文・達成条件・評価観点・期限を入力する modal を提示する。
2. When ユーザーが modal を送信する, the goal-management サービス shall 入力された目標定義を、実行ユーザーが所有する対象サイクルに属する目標として永続化する。
3. When 目標が保存される, the goal-management サービス shall 当該目標のロジック境界となる GoalAgent を実行ユーザー・サイクル・目標に対して確立する。
4. The goal-management サービス shall 達成条件と評価観点を複数行テキストとして保持する。
5. If 必須項目(目標名・目標本文)が空である, then the goal-management サービス shall 目標を保存せず、不足項目を示すエラー応答を返す。
6. If 目標を追加する対象サイクルが存在しない, then the goal-management サービス shall 目標を保存せず、先にサイクルを作成する必要がある旨を示す応答を返す。
7. When 目標の保存が成功する, the goal-management サービス shall 登録された目標名を含む確認応答を実行ユーザー本人にのみ可視となる形で返す。
8. The goal-management サービス shall 新規目標の初期ステータスを「判断材料不足(gray)」として保存する。

### Requirement 3: 証跡の削除
**Objective:** As a 個人ユーザー, I want `/evidence delete id:..` で自分の証跡を削除すること, so that 不要・誤登録の証跡を安全に取り除ける(プライバシー必須要件)

#### Acceptance Criteria
1. When ユーザーが `/evidence delete` を証跡 ID とともに実行する, the goal-management サービス shall 当該証跡が実行ユーザーの所有であることを確認したうえで証跡定義を削除する。
2. When 証跡が削除される, the goal-management サービス shall 当該証跡に紐づく目標リンクも併せて削除し、孤立した参照を残さない。
3. If 指定された証跡 ID が存在しない, then the goal-management サービス shall 削除を行わず、対象が見つからない旨を示すエラー応答を返す。
4. If 指定された証跡が実行ユーザーの所有ではない, then the goal-management サービス shall 削除を行わず、対象が見つからない旨を示す応答を返し、他ユーザーの証跡の存在を露出しない。
5. When 削除が成功する, the goal-management サービス shall 削除完了を示す応答を実行ユーザー本人にのみ可視となる形で返す。

### Requirement 4: 所有者スコープのアクセス制御
**Objective:** As a プライバシーを重視する個人ユーザー, I want すべての定義操作が実行ユーザー本人のデータに限定されること, so that 他ユーザーの評価データに一切アクセスできない(仕様書 §15)

#### Acceptance Criteria
1. The goal-management サービス shall サイクル・目標・証跡の作成・取得・削除のすべてにおいて、対象データを実行ユーザーが所有するものに限定する。
2. When 実行ユーザーが他ユーザーの所有するサイクル・目標・証跡を対象とする操作を要求する, the goal-management サービス shall その操作を実行せず、対象が存在しないかのように扱い、他ユーザーデータの存在を露出しない。
3. The goal-management サービス shall 永続化される全エンティティに所有者(実行ユーザー)識別子を関連付ける。
4. The goal-management サービス shall 個人の評価データを含む応答を、本人にのみ可視となる文脈(ephemeral または DM/個人用非公開チャンネル)に限定して返す。

### Requirement 5: 定義状態の管理と後続スペックへの提供
**Objective:** As a 後続機能(分類・判定・ドラフト)の実装者, I want サイクル・目標の定義状態が一貫して保持・取得できること, so that 分類・ステータス判定・ドラフト生成が定義済みの対象を参照できる

#### Acceptance Criteria
1. The goal-management サービス shall 1 つのサイクルに属する複数の目標定義の一覧を保持し、所有者スコープ内で取得可能にする。
2. The goal-management サービス shall 各目標の定義(目標名・本文・達成条件・評価観点・期限・ステータス)を保持し、所有者スコープ内で取得可能にする。
3. The goal-management サービス shall サイクル・目標・証跡の定義データを単一の権威(サイクル単位の永続化)に保存し、目標単位の操作も同一権威へ反映されるようにする。
4. The goal-management サービス shall サイクル/目標/証跡の永続化スキーマを再定義せず、上流が確立したスキーマと共有ドメイン型に従って読み書きする。

### Requirement 6: スペック境界の維持
**Objective:** As a システム運用者および後続スペック実装者, I want 本スペックが定義 CRUD と所有者制御のみを所有し、分類・判定・ドラフト・通知を実装しないこと, so that 各スペックが責務を重複させず独立して実装・テスト・レビューできる

#### Acceptance Criteria
1. The goal-management サービス shall 雑入力の目標分類・証跡の自動生成を実装しない(checkin-classification が所有)。
2. The goal-management サービス shall ステータス判定・評価文ドラフト生成・`/status`・`/goal status`・`/draft`・`/checkin` を実装しない(checkin-classification / status-and-draft が所有)。
3. The goal-management サービス shall 証跡の一覧表示(`/evidence list`)・定期通知・アラートを実装しない(status-and-draft / notifications が所有)。
4. The goal-management サービス shall Discord 署名検証・interaction ディスパッチ規約・応答プロトコル・コマンド登録手段・永続化スキーマ DDL・Agent クラス骨格・LLM クライアントを再定義せず、infra-foundation と discord-gateway が公開する契約を利用する。
