# Research & Design Decisions: infra-foundation

## Summary
- **Feature**: `infra-foundation`
- **Discovery Scope**: New Feature(グリーンフィールド)
- **Key Findings**:
  - Cloudflare `agents` パッケージの `Agent` 基底クラスは同期 `this.sql` タグ付きテンプレートで DO SQLite を操作でき、`onStart()` がスキーマ初期化に適する。
  - Agent インスタンスはクラス(DO binding)+ 名前(任意文字列)で一意特定でき、`getAgentByName(env.Binding, name)` で取得・RPC 呼び出しできる。仕様書 §6 の階層 ID をそのまま「名前」として使える。
  - Workers AI は `wrangler` の `ai.binding`(慣例 `AI`)経由で `env.AI.run(model, options)` を呼ぶ。プロバイダ差し替えは `LlmClient` インターフェイスで隠蔽する。

## Research Log

### Cloudflare Agents SDK の永続化 API
- **Context**: §11 全テーブルの DO SQLite スキーマとマイグレーションをどう実装するか。
- **Sources Consulted**: Context7 `/cloudflare/agents`(agent-class.md, configuration.md, routing.md)。
- **Findings**:
  - `this.sql\`...\`` は同期実行のタグ付きテンプレート。`CREATE TABLE IF NOT EXISTS`、パラメータ化 INSERT/SELECT をサポート。型パラメータ `this.sql<RowType>\`...\`` で行型を指定可能。
  - DO SQLite は `wrangler` の `migrations`(`new_sqlite_classes`)で Agent クラスを SQLite 対応として宣言する必要がある。これは「DO クラスのストレージ種別」のマイグレーションであり、アプリ内テーブル DDL とは別レイヤ。
  - `onStart()` はインスタンス起動時に走り、テーブル初期化の慣用フック。
- **Implications**: アプリ層のスキーマ適用は「冪等な DDL(`IF NOT EXISTS`)+ `schema_migrations` バージョン台帳」で実装し、`onStart()` から一度だけ走るマイグレーションランナーで適用する。各 Agent(EvaluationCycleAgent / GoalAgent)は独立した DO インスタンスごとに独立した SQLite を持つため、どのテーブルがどの Agent に属するかを設計で確定する必要がある。

### Agent ルーティングと階層 ID
- **Context**: §6 の `evaluation:{userId}:{cycleId}` / `...:goal:{goalId}` ID 規約と、Agent 間委譲をどう実装するか。
- **Sources Consulted**: Context7 `/cloudflare/agents`(routing.md, client-sdk.md, get-current-agent.md)。
- **Findings**:
  - `getAgentByName<T>(namespace, name, options?)` が DO スタブを返し、`stub.method()`(同一 Worker 内)または `call()` で RPC 可能。
  - 名前は任意文字列で、同じ名前は同じ論理インスタンスへ決定的に解決される(DO の名前 → ID 解決)。
  - Worker 内 RPC は `@callable()` 不要、外部ランタイムからの呼び出しのみ必要。
- **Implications**: §6 の階層文字列をそのまま DO 名として採用できる。基盤は ID 文字列の組み立て/分解ユーティリティと、`getCycleAgent(env, userId, cycleId)` / `getGoalAgent(env, userId, cycleId, goalId)` ルーティングヘルパーを提供する。EvaluationCycleAgent → GoalAgent の委譲はヘルパー経由の RPC とする。

### Workers AI 呼び出しと LLM 抽象化
- **Context**: 差し替え可能な LLM レイヤをどう設計するか(日本語品質リスクへの備え)。
- **Sources Consulted**: Context7 `/cloudflare/agents`(configuration.md)。
- **Findings**: `env.AI.run("@cf/...model", { prompt })` で推論。モデル ID は文字列。
- **Implications**: `LlmClient` インターフェイスを定義し、`complete(request)` / 構造化出力 `completeJson<T>(request, schema)` を公開。Workers AI 実装 `WorkersAiLlmClient` がモデル ID と `env.AI` を保持。プロバイダ/モデル選択は 1 箇所のファクトリ(`createLlmClient(env)`)に集約し、利用側は `LlmClient` だけに依存する。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A: EvaluationCycleAgent + 目標ごと GoalAgent(仕様書 §6) | サイクル親 Agent と目標ごと子 Agent | 仕様書準拠、責務分割が明確、目標単位の局所性 | DO インスタンス数増、データが Agent ごとに分散しクロス目標集計に RPC ファンアウトが必要 | 採用。下記 Decision 参照 |
| B: ユーザー単位 Agent(調査の代替案) | 1 ユーザー 1 Agent に全データ集約 | クロス目標クエリが 1 SQLite 内で完結、RPC 不要 | 仕様書 §6 と乖離、目標数増でホットスポット化、責務肥大 | 却下 |

## Design Decisions

### Decision: Agent トポロジは「EvaluationCycleAgent をデータ権威、GoalAgent を目標単位の論理 Agent」とするハイブリッド
- **Context**: ブリーフの「要設計判断」。仕様書 §6 案(目標ごと DO)と調査案(ユーザー単位 DO)のどちらを採るか。クロス目標の `/status` 集計とデータ一貫性が論点。
- **Alternatives Considered**:
  1. 案 A: 全 §11 テーブルを各 GoalAgent の SQLite に分散保持。
  2. 案 B: ユーザー単位 Agent に全集約。
  3. 案 C(採用): §6 の 2 Agent 構造を維持しつつ、**永続化の権威を EvaluationCycleAgent(サイクル単位 SQLite)に集約**。GoalAgent は同じサイクルの論理ビュー/目標単位ロジックの担い手とし、データ読み書きはサイクル Agent のリポジトリ経由(RPC)で行う。
- **Selected Approach**: 案 C。EvaluationCycleAgent の DO SQLite が §11 全テーブルの単一権威。GoalAgent は目標単位の判定/生成ロジックの責務境界を表す骨格を持ち、証跡・目標データは親 Agent のリポジトリへ委譲する。ID 規約は §6 通り。
- **Rationale**: (1) 仕様書 §6 の Agent 命名・責務分担を保持しつつ、(2) クロス目標集計(`/status` 全体)を 1 SQLite 内クエリで完結させ案 B の利点を取り込み、(3) データ二重管理・分散一貫性問題を回避する。基盤段階では骨格のみ確定し、各機能スペックがメソッド実体を埋める。
- **Trade-offs**: GoalAgent はデータを自前 SQLite に持たないため「目標ごと DO」の局所性は弱まるが、MVP 規模(個人利用・目標数件)では集計の単純さを優先するのが妥当。
- **Follow-up**: 各機能スペック実装時に GoalAgent ⇄ EvaluationCycleAgent の RPC 境界が肥大しないか監視。必要なら目標データの一部を GoalAgent にキャッシュする最適化を将来検討。

### Decision: スキーマは冪等 DDL + バージョン台帳方式
- **Context**: 「初回利用時に適用、再初期化で重複しない」要件(2.2/2.3)。
- **Selected Approach**: `schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)` 台帳を持ち、順序付きマイグレーション配列を未適用分だけ適用するランナーを `onStart()` から呼ぶ。各 DDL は `CREATE TABLE IF NOT EXISTS`。
- **Rationale**: DO SQLite はインスタンスごとに独立し、`onStart()` が毎起動走るため、適用済み判定が必須。台帳方式は将来のスキーマ拡張(基盤スペックの拡張)にも対応する。
- **Trade-offs**: 単純な `IF NOT EXISTS` のみでも初期は足りるが、台帳を入れることで列追加等の将来マイグレーションを安全に積める。

### Decision: LLM はインターフェイス + ファクトリで 1 箇所差し替え
- **Context**: 日本語品質未検証リスク(roadmap 制約)。要件 4.4。
- **Selected Approach**: `LlmClient` インターフェイス(`complete` / `completeJson<T>`)+ `WorkersAiLlmClient` 実装 + `createLlmClient(env)` ファクトリ。モデル ID とプロバイダ選択をファクトリ/設定に集約。
- **Rationale**: 利用側(各機能スペックのプロンプト)は `LlmClient` のみに依存。Claude API 等への差し替えは新実装クラス + ファクトリ 1 行変更で済む。
- **Trade-offs**: 構造化出力の保証方法(JSON パース/再試行)はプロバイダ差があるため、`completeJson` の契約(失敗時エラー)を明示しておく。

## Risks & Mitigations
- **Workers AI の日本語品質不足** — `LlmClient` 抽象化で差し替え可能化(本スペックで担保)。実プロンプト品質は各機能スペックの責務。
- **DO SQLite ストレージ課金(2026-01-07 以降)** — 個人利用・小規模のため影響軽微。設計上の追加対応不要。
- **GoalAgent ⇄ CycleAgent の RPC 過多** — 基盤では骨格のみ。実装時に往復回数を監視し、必要なら集約 API を親 Agent に追加。
- **マイグレーション順序の破壊的変更** — バージョン台帳により未適用分のみ適用。既存 version の DDL は変更せず、新 version を追記する運用とする。

## References
- Context7 `/cloudflare/agents` — agent-class.md(`this.sql`, `onStart`), configuration.md(wrangler bindings, `env.AI.run`), routing.md(`getAgentByName`), client-sdk.md(RPC stub)。
- `goal-agent-spec.md` §6(Agent 設計・ID 規約), §11(データモデル), §13(LLM 処理仕様)。
