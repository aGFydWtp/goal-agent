# 評価目標フォロー Agent SPEC v0.1

## 1. 概要

半期ごとに立てた評価目標を、Discord Bot 経由で継続的に追跡する。
ユーザーは毎週、今週やったことを雑に入力するだけでよい。Agent が内容を各評価目標に分類し、証跡として保存し、進捗・不足・次アクション・評価文ドラフトを生成する。

専用ダッシュボードは作らず、**Discord DM / 非公開チャンネル上のチャット UI**で完結させる。

---

## 2. 目的

### 解決したい課題

評価目標は半期の初めに立てるが、日々の業務の中で意識し続けるのが難しい。

特に次の問題を解決する。

```txt
期初に目標を立てる
↓
日々の活動が目標に紐づかず流れる
↓
評価前に実績を思い出す
↓
証跡が足りない / 説明が弱い
```

この Agent は、日々・週次の活動を **評価可能な証跡** に変換する。

---

## 3. コンセプト

```txt
ユーザー:
今週やったことを雑に書く

Agent:
目標に分類する
証跡化する
不足を指摘する
次アクションを提案する
評価文に変換する
```

UI の中心はダッシュボードではなく、**週次チェックイン**。

---

## 4. 想定利用者

初期対象は個人利用。

```txt
対象:
- 半期評価目標を複数持つ個人
- 週次で振り返りたい人
- 評価前に実績整理を楽にしたい人

初期スコープ外:
- チーム全体の目標管理
- 上司による監視
- 人事評価システムとの直接連携
```

---

## 5. システム構成

```txt
Discord
  ├─ DM
  ├─ Slash Command
  ├─ Button
  └─ Modal
        ↓
Cloudflare Worker
        ↓
Cloudflare Agents
  ├─ EvaluationCycleAgent
  └─ GoalAgent
        ↓
Durable Object SQLite
```

---

## 6. Agent 設計

### 6.1 EvaluationCycleAgent

半期全体を管理する親 Agent。

```txt
Agent ID:
evaluation:{userId}:{cycleId}

例:
evaluation:haruki:2026H1
```

責務:

```txt
- 半期全体の目標一覧を管理
- 証跡候補を受け取る
- どの目標に関係するか分類する
- GoalAgent に処理を委譲する
- 半期全体の /status を生成する
- 評価文の全体版を生成する
```

---

### 6.2 GoalAgent

評価目標1つにつき1 Agent。

```txt
Agent ID:
evaluation:{userId}:{cycleId}:goal:{goalId}

例:
evaluation:haruki:2026H1:goal:ai-adoption
evaluation:haruki:2026H1:goal:quality-improvement
```

責務:

```txt
- 目標定義を保持
- マイルストーンを保持
- 紐づく証跡を管理
- 進捗状態を判定
- 不足している証跡を指摘
- 次アクションを提案
- 目標単位の評価文を生成
```

---

## 7. Discord インターフェイス

### 7.1 基本方針

専用画面は作らず、Discord で完結する。

```txt
見る場所:
Discord DM または個人用非公開チャンネル

入力:
自然文メッセージ
Slash Command
Modal

確認:
Button
```

---

## 8. コマンド仕様

### 8.1 `/cycle create`

半期サイクルを作成する。

#### 入力

```txt
/cycle create name:2026H1 start:2026-04-01 end:2026-09-30
```

#### 処理

```txt
EvaluationCycleAgent を作成する
```

#### 返答例

```txt
2026H1 の評価サイクルを作成しました。

期間:
2026-04-01 〜 2026-09-30

次に /goal add で目標を登録してください。
```

---

### 8.2 `/goal add`

評価目標を登録する。

#### 入力

```txt
/goal add
```

Modal を開く。

#### Modal 項目

```txt
目標名
目標本文
達成条件
評価観点
期限
```

#### 例

```txt
目標名:
生成AI活用・導入

目標本文:
生成AIやAI Agentを活用し、開発速度・品質・ナレッジ共有を改善する。

達成条件:
- 業務適用候補を3件以上整理
- MVPを1つ以上試作
- チーム共有を1回以上実施
- 効果・課題を振り返る
```

#### 処理

```txt
GoalAgent を作成する
目標定義を保存する
```

---

### 8.3 `/checkin`

週次チェックインを手動開始する。

#### 入力

```txt
/checkin
```

#### Bot 返答

```txt
今週やったことを雑に書いてください。
評価目標に関係あるかどうかはこちらで分類します。
```

#### ユーザー返信例

```txt
Cloudflare Agents を調べた。
Durable Objects について整理した。
評価目標フォロー Agent の設計を考えた。
pnpm cache の問題も少し見た。
```

#### Agent の分類結果

```txt
分類案です。

目標1: 生成AI活用・導入
- Cloudflare Agents の調査
- Durable Objects の整理
- 評価目標フォロー Agent の設計

目標2: 開発基盤改善
- pnpm cache 問題の調査

未分類:
なし

この内容を証跡として保存しますか？
```

#### Button

```txt
[保存]
[修正]
[破棄]
```

---

### 8.4 `/status`

半期全体の進捗を見る。

#### 入力

```txt
/status
```

#### 返答例

```txt
2026H1 評価目標ステータス

目標1: 生成AI活用・導入
状態: Yellow
理由:
調査・構想は進んでいますが、実装とチーム展開の証跡がまだ不足しています。

目標2: 開発基盤改善
状態: Green
理由:
技術課題の調査・対応履歴が継続的に記録されています。

目標3: 技術発信
状態: Red
理由:
3週間、証跡が追加されていません。

今週やるとよいこと:
- 目標1: MVPを1つ決める
- 目標3: Cloudflare Agents の調査内容を社内メモ化する
```

---

### 8.5 `/goal status`

特定の目標の詳細を見る。

#### 入力

```txt
/goal status goal:ai-adoption
```

#### 返答例

```txt
目標: 生成AI活用・導入
状態: Yellow

Agent の見立て:
調査・構想は進んでいます。
一方で、評価上は「実際に試作した」「誰かに共有した」「効果を確認した」という証跡がまだ弱いです。

保存済み証跡:
- 2026-06-13 Cloudflare Agents を調査
- 2026-06-13 Durable Objects を整理
- 2026-06-13 評価目標フォロー Agent の設計を検討

不足:
- MVP実装
- チーム共有
- 効果測定

次アクション:
1. MVP対象を1つ決める
2. GoalAgent のデータ構造を作る
3. 週次チェックインだけ動かす
```

---

### 8.6 `/evidence list`

保存済み証跡を見る。

#### 入力

```txt
/evidence list
```

#### 返答例

```txt
保存済み証跡

2026-06-13
内容:
Cloudflare Agents と Durable Objects を調査した。

紐づく目標:
- 生成AI活用・導入

評価への使いやすさ:
中

補足:
調査実績としては使えるが、成果物や共有実績があるとより強い。
```

---

### 8.7 `/draft`

評価文ドラフトを生成する。

#### 入力

```txt
/draft goal:ai-adoption
```

または半期全体。

```txt
/draft all
```

#### 返答例

```txt
自己評価ドラフト

生成AI活用については、Cloudflare Agents / Durable Objects などの
新しい Agent 基盤を調査し、業務適用可能性を検討した。

特に、会議後フォロー Agent、評価目標フォロー Agent など、
単なるチャットではなく、状態を持ち定期的にフォローする
実用アプリ案を具体化した。

一方で、現時点では実装・チーム展開の証跡はまだ不足している。
今後は、評価目標フォロー Agent を MVP として試作し、
週次チェックインと証跡管理の有効性を検証する。
```

Button:

```txt
[短くする]
[成果を強める]
[課題を明確にする]
[上司向けにする]
[保存]
```

---

## 9. 定期通知仕様

### 9.1 週次チェックイン

#### 初期設定

```txt
毎週金曜 16:30
```

#### 通知内容

```txt
今週の評価目標チェックインです。

今週やったことを雑に書いてください。
目標に関係あるかどうかはこちらで分類します。

現在の状態:
- Green: 1件
- Yellow: 1件
- Red: 1件
```

---

### 9.2 1on1 / 評価面談前通知

初期MVPではカレンダー連携はしない。
手動コマンドで代替する。

```txt
/prepare 1on1
```

将来的には Google Calendar 連携で、予定名に以下を含む場合に通知する。

```txt
1on1
評価面談
目標面談
振り返り
```

---

### 9.3 Red / Yellow アラート

状態が悪化した場合に通知する。

#### トリガー

```txt
Green → Yellow
Yellow → Red
証跡なしが2週間継続
半期終了30日前
半期終了14日前
```

#### 通知例

```txt
目標「技術発信」が Red になりました。

理由:
- 3週間、証跡が追加されていません
- 半期終了まで残り45日です
- 達成条件のうち2件が未着手です

改善案を見る場合は /goal status tech-sharing を実行してください。
```

---

## 10. ステータス判定

### 10.1 状態

```txt
Green: 順調
Yellow: 進んでいるが不足あり
Red: 未達リスクあり
Gray: 判断材料不足
```

---

### 10.2 判定ルール v0.1

初期はルールベース + LLM の見立てで判定する。

#### Green

```txt
- 直近2週間以内に証跡がある
- 達成条件の一部が完了している
- 次アクションが明確
- 評価文に使える成果がある
```

#### Yellow

```txt
- 活動はあるが成果物が弱い
- 調査・検討に偏っている
- 期限に対して進捗がやや遅い
- 評価文に使うには補足が必要
```

#### Red

```txt
- 3週間以上証跡がない
- 達成条件がほぼ未着手
- 半期終了が近い
- 次アクションが曖昧
```

#### Gray

```txt
- 目標定義が曖昧
- 証跡が少なすぎる
- 達成条件が未設定
```

---

## 11. データモデル

### 11.1 evaluation_cycles

```sql
CREATE TABLE evaluation_cycles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

### 11.2 goals

```sql
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  success_criteria TEXT,
  evaluation_points TEXT,
  status TEXT NOT NULL DEFAULT 'gray',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

### 11.3 milestones

```sql
CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

status:

```txt
todo
doing
done
dropped
```

---

### 11.4 checkins

```sql
CREATE TABLE checkins (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  week_start_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

---

### 11.5 evidence

```sql
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  title TEXT,
  body TEXT NOT NULL,
  evidence_date TEXT NOT NULL,
  usefulness TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

source_type:

```txt
manual_checkin
discord_message
github_pr
meeting_note
calendar_event
other
```

usefulness:

```txt
low
medium
high
```

---

### 11.6 evidence_goal_links

```sql
CREATE TABLE evidence_goal_links (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  relevance_score REAL NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
```

---

### 11.7 weekly_reviews

```sql
CREATE TABLE weekly_reviews (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  week_start_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  risks TEXT,
  next_actions TEXT,
  created_at TEXT NOT NULL
);
```

---

### 11.8 drafts

```sql
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  goal_id TEXT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

type:

```txt
self_evaluation
one_on_one
manager_summary
short_summary
```

---

## 12. 主要フロー

### 12.1 初期設定フロー

```txt
1. /cycle create
2. /goal add で目標を複数登録
3. Agent が目標を構造化
4. 必要ならマイルストーンを提案
5. 週次チェックインをスケジュール
```

---

### 12.2 週次チェックインフロー

```txt
1. 金曜に Bot が DM
2. ユーザーが今週やったことを雑に返信
3. EvaluationCycleAgent が内容を分解
4. 各 GoalAgent に関連度を問い合わせ
5. 分類案を Discord に返す
6. ユーザーが保存 / 修正 / 破棄
7. 保存後、週次レビューを生成
8. 必要ならステータス更新
```

---

### 12.3 評価文生成フロー

```txt
1. ユーザーが /draft を実行
2. Agent が対象目標の証跡を取得
3. 事実・成果・課題・次アクションに整理
4. 自己評価文を生成
5. Discord 上で調整ボタンを出す
6. ユーザーが保存
```

---

## 13. LLM 処理仕様

### 13.1 チェックイン分類

入力:

```txt
- 半期目標一覧
- 各目標の達成条件
- ユーザーの今週の入力
```

出力:

```json
{
  "items": [
    {
      "text": "Cloudflare Agents を調査した",
      "candidateGoals": [
        {
          "goalId": "ai-adoption",
          "relevanceScore": 0.92,
          "reason": "AI Agent 基盤の調査であり、生成AI活用目標に直接関係する"
        }
      ],
      "usefulness": "medium",
      "suggestedEvidenceTitle": "Cloudflare Agents の調査"
    }
  ]
}
```

---

### 13.2 ステータス判定

入力:

```txt
- 目標定義
- 達成条件
- マイルストーン
- 保存済み証跡
- 半期終了までの日数
```

出力:

```json
{
  "status": "yellow",
  "reason": "調査・構想は進んでいるが、実装や共有の証跡が不足している",
  "risks": [
    "実装成果がないと評価上の説得力が弱い",
    "チーム展開の実績がまだない"
  ],
  "nextActions": [
    "MVPを1つ選ぶ",
    "小さな実装証跡を作る",
    "チーム共有メモを作成する"
  ]
}
```

---

### 13.3 評価文生成

必ず以下を分ける。

```txt
事実:
何をしたか

解釈:
それが目標にどう効いたか

課題:
何が不足しているか

次アクション:
今後どうするか
```

誇張しすぎない。
保存済み証跡にない内容は「推測」として扱う。

---

## 14. Discord Message UX

### 14.1 分類確認メッセージ

```txt
分類案です。

目標1: 生成AI活用・導入
- Cloudflare Agents の調査
- Durable Objects の整理

目標2: 開発基盤改善
- pnpm cache 問題の調査

保存しますか？
```

Buttons:

```txt
保存
修正
破棄
```

---

### 14.2 保存後メッセージ

```txt
保存しました。

今週の見立て:
目標1は Yellow です。

理由:
構想は進んでいますが、まだ実装証跡が不足しています。

来週やるとよいこと:
- MVP候補を1つ決める
- 最小データモデルを作る
- 週次チェックインだけ動かす
```

---

## 15. セキュリティ・プライバシー

評価目標や自己評価文は個人情報性が高い。
初期MVPでは以下を必須にする。

```txt
- Discord DM または個人用非公開チャンネルのみ
- 他ユーザーのデータにアクセス不可
- 保存前にユーザー確認
- 自動分類結果は即確定しない
- 生成された評価文は必ずドラフト扱い
- 削除コマンドを用意
```

---

## 16. 削除・修正コマンド

### `/evidence delete`

```txt
/evidence delete id:xxx
```

### `/goal edit`

```txt
/goal edit goal:ai-adoption
```

### `/cycle archive`

```txt
/cycle archive 2026H1
```

---

## 17. MVP スコープ

### 作るもの

```txt
- Discord Bot
- /cycle create
- /goal add
- /checkin
- /status
- /goal status
- /draft
- 週次チェックイン通知
- 保存確認ボタン
- Cloudflare Agents
- SQLite 保存
```

### 作らないもの

```txt
- Web ダッシュボード
- GitHub 自動連携
- Slack 自動連携
- Google Calendar 連携
- 複数ユーザー管理画面
- 上司共有機能
- 人事評価システム連携
```

---

## 18. 成功指標

MVP の成功は、機能数ではなく継続利用で見る。

```txt
- 4週間連続でチェックインできる
- 各目標に証跡が3件以上たまる
- /status が現状把握に使える
- /draft が評価文作成の下書きとして使える
- ユーザーが「評価前に思い出す負担が減った」と感じる
```

---

## 19. 将来拡張

### Phase 2

```txt
- GitHub PR / Issue の証跡候補取り込み
- Discord メッセージからの証跡登録
- Evidence Inbox
- 目標ごとのマイルストーン編集
```

### Phase 3

```txt
- Google Calendar 連携
- 1on1前の準備通知
- 評価文編集用Web画面
- 証跡一覧Web画面
```

### Phase 4

```txt
- チーム利用
- 上司共有用ビュー
- 評価制度テンプレート対応
- 目標設定そのものの支援
```

---

## 20. 最初に作る最小版

本当に最小なら、これだけでよいです。

```txt
1. 目標を登録する
2. 毎週Discordで聞く
3. 雑入力を目標に分類する
4. 保存確認する
5. /status で進捗を見る
6. /draft で評価文を作る
```

このMVPで検証したい仮説は1つです。

```txt
評価目標管理は、ダッシュボードよりも
「毎週聞いてくれるチャット Agent」の方が続くのではないか
```

この仮説が当たれば、あとから Evidence 一覧や編集画面を足せばよいです。
