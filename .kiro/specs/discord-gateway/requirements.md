# Requirements Document

## Introduction
本スペックは評価目標フォロー Agent の全機能が共有する「Discord 入出力ゲートウェイ(discord-gateway)」を定義する。Discord の slash command / modal submit / button(message component)はすべて HTTP POST で Cloudflare Worker に届くため、署名検証・PING/PONG・3秒以内の初期応答・後続 follow-up・プロアクティブ送信といった Discord I/O 規約を、各機能が個別実装せず単一の共通基盤として利用できる契約を確立する。

利用者(=下位スペック goal-management / checkin-classification / status-and-draft / notifications の実装者、および Worker を登録・運用する運用者)が観測できる契約として、(a) 署名検証付き interactions エンドポイント、(b) slash command 登録手段、(c) interaction 種別ディスパッチ、(d) deferred + follow-up パターン、(e) プロアクティブ送信ヘルパーを提供する。本ゲートウェイは個別コマンドのビジネスロジック・UX 文言・通知スケジュール・永続化スキーマを所有せず、上流 infra-foundation が確立した Agent トポロジ・共有型・LLM クライアントを消費する。プライバシー要件(仕様書 §15: DM/個人用非公開チャンネル限定)を構造的に強制する。

## Boundary Context
- **In scope**: Ed25519 署名検証、PING(type1)→PONG(type1)、slash command 登録手段、interaction 種別(application command / modal submit / message component)のディスパッチ規約、3秒以内の deferred 応答(type5)と follow-up webhook による本応答送信パターン、modal を開く応答(type9)、bot token を用いたプロアクティブ送信ヘルパー(DM チャンネル open → メッセージ送信、DM 失敗時のチャンネルフォールバック)、プライバシー前提(DM/個人用非公開チャンネル限定)の構造的強制。
- **Out of scope**: 個別 slash command(/cycle, /goal, /checkin, /status, /draft, /evidence delete 等)のビジネスロジック・引数定義の内容・UX 文言(各機能スペックが所有)、`this.schedule()` による通知トリガのスケジューリング(notifications が所有。本スペックは送信ヘルパーのみ提供)、永続化スキーマ・Agent トポロジ・LLM クライアント実装(infra-foundation が所有)。
- **Adjacent expectations**: 本ゲートウェイは infra-foundation が公開する Agent 取得/ルーティングヘルパー・共有型・`Env` バインディングを再定義せず利用する。各機能スペックは本ゲートウェイが定めるディスパッチ規約・deferred/follow-up パターン・送信ヘルパーに従ってコマンド処理を実装し、署名検証や Discord 応答プロトコルを再実装しないことを前提とする。コマンド定義(名前・引数スキーマ)は各機能スペックが供給し、本ゲートウェイは登録手段と登録対象の受け口のみを提供する。

## Requirements

### Requirement 1: 署名検証と PING/PONG ハンドシェイク
**Objective:** As a 運用者, I want interactions エンドポイントが Discord の署名検証と PING 応答を正しく処理すること, so that Discord 開発者ポータルでエンドポイント登録が成功し、不正なリクエストを拒否できる

#### Acceptance Criteria
1. When interactions エンドポイントが POST リクエストを受信する, the ゲートウェイ shall リクエストの Ed25519 署名ヘッダ(signature と timestamp)と raw ボディを用いて公開鍵で署名を検証する。
2. If 署名検証に失敗する, then the ゲートウェイ shall ハンドラ処理を行わず 401 を返す。
3. If 署名ヘッダ(signature または timestamp)が欠落している, then the ゲートウェイ shall ハンドラ処理を行わず 401 を返す。
4. When 署名検証に成功し interaction の type が PING(type1)である, the ゲートウェイ shall type が PONG(type1)の JSON 応答を返す。
5. The ゲートウェイ shall 署名検証に用いる Discord 公開鍵を環境設定値として参照する。
6. When 署名検証済みの非 PING interaction を受信する, the ゲートウェイ shall ディスパッチ処理へ引き渡す。

### Requirement 2: slash command 登録手段
**Objective:** As a 運用者, I want slash command を Discord に登録する手段, so that 各機能スペックが定義したコマンドを Discord 上で利用可能にできる

#### Acceptance Criteria
1. The ゲートウェイ shall 各機能スペックが供給するコマンド定義の集合を Discord に登録する手段を提供する。
2. When 運用者が登録手段を実行する, the 登録手段 shall Discord アプリケーション ID と bot token を用いてコマンド定義を Discord API へ送信する。
3. If 登録に必要な認証情報(アプリケーション ID または bot token)が欠落している, then the 登録手段 shall 何も登録せず、不足している設定を示すエラーを返す。
4. Where 開発用のギルド単位登録が指定される, the 登録手段 shall 指定されたギルドに対してコマンドを登録する。
5. The 登録手段 shall コマンド定義集合を単一の参照元から受け取り、各機能スペックがそこへ自分のコマンド定義を追加できる構造にする。

### Requirement 3: interaction 種別ディスパッチ
**Objective:** As a 基盤利用者(下位スペック実装者), I want interaction を種別ごとに適切なハンドラへ振り分ける規約, so that 各機能が署名検証や種別判定を再実装せずコマンド処理だけに集中できる

#### Acceptance Criteria
1. When 署名検証済みの application command interaction(type2)を受信する, the ゲートウェイ shall コマンド名に対応して登録されたコマンドハンドラへ振り分ける。
2. When 署名検証済みの message component interaction(type3、button 等)を受信する, the ゲートウェイ shall custom_id に対応して登録されたコンポーネントハンドラへ振り分ける。
3. When 署名検証済みの modal submit interaction(type5、modal)を受信する, the ゲートウェイ shall custom_id に対応して登録された modal ハンドラへ振り分ける。
4. If 受信した interaction の種別または識別子に対応するハンドラが登録されていない, then the ゲートウェイ shall 利用者が観測できるエラー応答を返し、未処理を判別可能にする。
5. The ゲートウェイ shall 各ハンドラに対し、対応する interaction の内容(コマンド名・引数・custom_id・実行ユーザー・チャンネル/DM 文脈)を提供する。
6. The ゲートウェイ shall 各機能スペックがハンドラを識別子(コマンド名・custom_id)に対応付けて登録できる規約を提供する。

### Requirement 4: deferred 応答と follow-up パターン
**Objective:** As a 基盤利用者, I want 3秒以内に deferred 応答を返し重い処理後に本応答を送る共通パターン, so that LLM 呼び出し等の長い処理を伴うコマンドが Discord のタイムアウトに違反せず応答できる

#### Acceptance Criteria
1. Where ハンドラが即時に完了できない処理(LLM 呼び出し等)を伴うと宣言する, the ゲートウェイ shall 3秒以内に deferred 応答(type5: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)を返す。
2. When deferred 応答を返した後に重い処理が完了する, the ゲートウェイ shall follow-up webhook を用いて本応答メッセージを送信する。
3. The ゲートウェイ shall deferred 応答後の重い処理が初期 HTTP 応答の返却後も Worker 上で継続実行されるようにする。
4. If deferred 後の処理が失敗する, then the ゲートウェイ shall 利用者へ失敗を伝えるための follow-up 送信手段を提供する。
5. Where ハンドラが即時に応答できる軽量処理である, the ゲートウェイ shall deferred を経由せず即時応答(type4: CHANNEL_MESSAGE_WITH_SOURCE)を返せる手段を提供する。
6. Where 応答を本人にのみ表示すべき場合, the ゲートウェイ shall 応答を ephemeral(本人のみ可視)として送信できる手段を提供する。
7. Where ハンドラが application command または message component への応答として入力フォーム(modal)を開くことを宣言する, the ゲートウェイ shall Discord interaction response type9(MODAL)を初期応答として返し、ハンドラが指定した custom_id・タイトル・入力フィールド(action row 内の text input)を modal payload として送出する。

### Requirement 5: プロアクティブメッセージ送信ヘルパー
**Objective:** As a 基盤利用者(notifications 実装者等), I want bot token で DM/チャンネルへプロアクティブに送信するヘルパー, so that interaction 以外の契機(週次通知・アラート)でユーザーへメッセージを届けられる

#### Acceptance Criteria
1. When 呼び出し元がユーザーへのプロアクティブ送信を要求する, the 送信ヘルパー shall 対象ユーザーの DM チャンネルを開き、そこへメッセージを送信する。
2. If DM チャンネルへの送信が拒否される(対象ユーザーが DM を許可していない等の 403), then the 送信ヘルパー shall 指定された代替チャンネルへのメッセージ送信にフォールバックする。
3. If DM 送信が失敗し、かつ代替チャンネルが指定されていない, then the 送信ヘルパー shall 呼び出し元が判別できる形で失敗を返す。
4. The 送信ヘルパー shall bot token を環境設定値として参照し、Discord REST API を用いて送信する。
5. The 送信ヘルパー shall プロアクティブ送信の宛先を DM または個人用非公開チャンネルに限定し、公開チャンネルや他ユーザーへの送信を行わない。

### Requirement 6: プライバシー前提の強制
**Objective:** As a システム運用者および基盤利用者, I want ゲートウェイがプライバシー前提(§15)を構造的に強制すること, so that 評価データが DM/個人用非公開の文脈以外に露出しない

#### Acceptance Criteria
1. The ゲートウェイ shall interaction を処理するハンドラに対し、実行ユーザーの識別子を一貫して提供し、各ハンドラが他ユーザーのデータを参照しない前提を保てるようにする。
2. While interaction 応答を返す, the ゲートウェイ shall 個人の評価データを含みうる応答を ephemeral または DM/個人用非公開チャンネル文脈に限定できる手段を提供する。
3. The ゲートウェイ shall プロアクティブ送信を DM または個人用非公開チャンネルに限定する(公開チャンネルへの個人評価データ送信を行わない)。
4. If 公開チャンネル等の許可されない文脈での個人データ送信が要求される, then the ゲートウェイ shall その送信を行わない。

### Requirement 7: ゲートウェイ境界の維持
**Objective:** As a システム運用者および基盤利用者, I want ゲートウェイが個別コマンドの中身を実装せず I/O 規約のみを提供すること, so that 各機能スペックが責務を重複させず独立して実装・テスト・レビューできる

#### Acceptance Criteria
1. The ゲートウェイ shall 個別 slash command(/cycle, /goal, /checkin, /status, /draft, /evidence delete 等)のビジネスロジック・引数の意味・UX 文言を実装しない。
2. The ゲートウェイ shall 週次通知・アラートのスケジューリング判定を実装しない(送信ヘルパーのみを提供する)。
3. The ゲートウェイ shall 永続化スキーマ・Agent トポロジ・LLM クライアント実装を再定義せず、infra-foundation が公開する契約を利用する。
4. The ゲートウェイ shall コマンド定義・ハンドラ本体を各機能スペックから受け取る登録規約を提供し、ゲートウェイ自身はコマンドの内容を保持しない。
