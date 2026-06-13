# Research & Design Decisions

## Summary
- **Feature**: `goal-management`
- **Discovery Scope**: Extension(上流 2 スペックの確立済み契約上に乗るドメイン CRUD。統合中心の light discovery)
- **Key Findings**:
  - 永続化スキーマ(§11)・Agent トポロジ・共有型は infra-foundation が単独所有。本スペックは `Repository` と Agent 骨格メソッドを「埋める」だけで、新規スキーマや Agent クラスは定義しない。
  - Discord I/O(署名検証・ディスパッチ・modal/button・deferred/follow-up・ephemeral・コマンド登録集約点)は discord-gateway が所有。本スペックはハンドラ登録規約に従ってコマンド/modal ハンドラを供給するのみ。
  - 全 CRUD は所有者スコープ(`user_id`)強制が必須(§15)。アクセス制御は本スペックのドメインロジック側で強制する(ゲートウェイは実行ユーザー ID 供給まで)。

## Research Log

### 上流契約の消費点(infra-foundation)
- **Context**: 本スペックがどの公開契約に依存し、何を再定義してはならないかを確定する。
- **Sources Consulted**: `.kiro/specs/infra-foundation/design.md`(Repository / Agent IDs+Routing / EvaluationCycleAgent・GoalAgent / Data Models §11)。
- **Findings**:
  - `Repository.insert/getById/listBy/update/remove`(エンティティ単位、型付き低レベル read/write)が利用可能。ビジネスルールは持たない(本スペックが所有)。
  - `getCycleAgent(env,userId,cycleId)` / `getGoalAgent(env,userId,cycleId,goalId)` でルーティング。`cycleAgentName`/`goalAgentName` は §6 規約。
  - EvaluationCycleAgent がサイクル単位 SQLite の単一権威。GoalAgent はステートレスで親へ RPC 委譲。`onStart()` でマイグレーション適用済み。
  - §11 テーブル: `evaluation_cycles`/`goals`/`evidence`/`evidence_goal_links` が本スペックの対象。`goals.status` 既定 `'gray'`、`goals.success_criteria`/`evaluation_points` は NULL 許容 TEXT(複数行)。
- **Implications**: 本スペックは「定義 CRUD のビジネスロジック」を Agent 骨格メソッドおよびハンドラに実装し、データアクセスは必ず Repository 経由(GoalAgent は親委譲)とする。スキーマ追加・変更は禁止(必要なら infra 拡張)。

### 上流契約の消費点(discord-gateway)
- **Context**: コマンド/modal/button のルーティングと応答契約を確定する。
- **Sources Consulted**: `.kiro/specs/discord-gateway/design.md`(types / registry / dispatch / response / commands)。
- **Findings**:
  - `registerHandler(kind, name, handler)` で `(kind, name)` をキーに登録。`kind` は `command`/`component`/`modal`、`name` はコマンド名 or custom_id。
  - `InteractionContext` が `userId`(必須)・`name`・`channelId`・`isDm`・`token`・`raw` を供給。
  - `HandlerResult` は `reply`(即時 type4、ephemeral 可)または `deferred`(type5 + `run(followup)`)。
  - コマンド定義は `commands/definitions.ts` 集約配列へ各機能が追加。modal の提示は応答(modal を開く interaction 応答)で行う。
- **Implications**: `/cycle create` は即時 `reply`(ephemeral)、`/goal add` は modal を開く応答 → modal submit ハンドラで保存、`/evidence delete` は即時 `reply`(ephemeral)。LLM を呼ばないため基本は即時応答で 3 秒制約を満たす(deferred は不要)。

### modal をどう開くか
- **Context**: discord-gateway の `HandlerResult` は `reply`/`deferred` のみで「modal を開く(type9 MODAL)」が型に明示されていない。
- **Findings**: Discord の application command 応答として MODAL(type9)を返す必要がある。`HandlerResult` の現行 2 形では表現できない。
- **Implications**: 本スペックは `/goal add` ハンドラで modal 応答を返す必要がある。design では「modal を開く応答手段」をゲートウェイの応答契約に依存して用いると記述しつつ、現行契約で未提供なら revalidation trigger として記録し、ゲートウェイの応答ユーティリティ(`response.ts`)が modal 応答を提供する前提で配線する。これは discord-gateway 側の応答契約に属するため、本スペックは「modal 応答ボディの生成手段の利用」を前提とし、custom_id ルーティングのみ本スペックが所有する。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| ハンドラ薄層 + Agent ドメインロジック | コマンド/modal ハンドラは入力解釈と応答整形のみ。CRUD ビジネスルールは EvaluationCycleAgent/GoalAgent の骨格メソッドに実装 | 上流境界に忠実。テストはハンドラ単体 + Agent ドメイン単体で分離 | ハンドラ↔Agent の往復配線が必要 | 採用 |
| ハンドラに全 CRUD を集約 | Agent 骨格を素通りし、ハンドラから直接 Repository | 配線が単純 | infra が定めた Agent 責務(目標一覧管理=Cycle、目標定義=Goal)を空洞化し境界逸脱 | 却下 |

## Design Decisions

### Decision: CRUD ビジネスロジックは Agent 骨格メソッドに実装し、ハンドラは薄層に保つ
- **Context**: infra-foundation は Agent 骨格(責務境界メソッド)を宣言済みで、ドメインロジックは下位スペックが埋めると明記。
- **Alternatives Considered**:
  1. Agent メソッドに CRUD を実装し、ハンドラは入出力変換のみ。
  2. ハンドラから Repository を直接叩く。
- **Selected Approach**: EvaluationCycleAgent に「サイクル作成・目標登録・目標一覧/取得・証跡削除」を、GoalAgent に「目標定義保持・取得」をドメインメソッドとして実装。GoalAgent のデータ操作は親 Cycle Agent の Repository へ RPC 委譲。ハンドラは `InteractionContext` から入力を取り、Agent を呼び、応答を整形する薄層。
- **Rationale**: 上流の Agent 責務分担(§6: Cycle=目標一覧管理、Goal=目標定義保持)に一致し、単一権威(Cycle SQLite)を維持。
- **Trade-offs**: ハンドラ↔Agent 往復が増えるが、境界の明確さとテスト容易性を優先。
- **Follow-up**: GoalAgent→Cycle の RPC 過多は infra の既知フォローアップ。MVP 規模では許容。

### Decision: 所有者スコープを全ドメインメソッドで強制
- **Context**: §15 必須要件。ゲートウェイは `userId` 供給まで、強制は本スペック責務(infra design の Security Considerations 参照)。
- **Selected Approach**: Agent 名に `userId` が含まれる(`evaluation:{userId}:{cycleId}`)ため、ルーティング時点でユーザーが分離される。加えて全 read/write で `user_id` 一致を検証し、不一致は「存在しない」として扱う(他ユーザーデータの存在を露出しない)。
- **Rationale**: 構造的分離(Agent 名)+ 明示的検証(行レベル `user_id`)の二重防御。
- **Trade-offs**: 検証コードが各メソッドに分散するが、ヘルパーで集約。
- **Follow-up**: 証跡削除はリンク(`evidence_goal_links`)の連動削除を含む。

### Decision: LLM 非依存のため即時応答を基本とする
- **Context**: 本スペックの CRUD は LLM を呼ばない。
- **Selected Approach**: `/cycle create`・`/evidence delete` は即時 `reply`(ephemeral)。`/goal add` は modal 応答 → modal submit で即時 `reply`。
- **Rationale**: 3 秒制約を deferred なしで満たせ、UX が単純。
- **Trade-offs**: なし(SQLite 書き込みは高速)。

## Risks & Mitigations
- modal を開く応答(type9 MODAL)が discord-gateway の現行 `HandlerResult` に明示されていない — 応答契約はゲートウェイ所有。modal 応答ボディ生成手段の利用を前提とし、未提供時は revalidation trigger としてゲートウェイ側へ差し戻す(本スペックは custom_id ルーティングのみ所有)。
- GoalAgent→Cycle Agent の RPC 過多 — MVP 規模では許容、infra フォローアップで監視。
- 重複サイクル名検出の判定基準(同一ユーザー内の name 一致)— 所有者スコープ内の `name` 完全一致で判定。

## References
- `.kiro/specs/infra-foundation/design.md` — Repository / Agent routing / §11 schema / 共有型(消費する契約)
- `.kiro/specs/discord-gateway/design.md` — registry / InteractionContext / HandlerResult / deferred-followup / commands 集約点(消費する契約)
- `goal-agent-spec.md` §8.1, §8.2, §11.1, §11.2, §11.5, §11.6, §15, §16 — コマンド・スキーマ・プライバシー・削除の権威定義
