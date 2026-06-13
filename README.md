# goal-agent — インフラ基盤 (infra-foundation)

評価目標フォロー Agent の共通実行基盤(Cloudflare Workers + Agents SDK / TypeScript)です。本リポジトリは下位スペックが乗る土台のみを提供し、Discord 機能やドメイン CRUD は含みません。

本 README は開発者向けに、前提条件・セットアップ・ローカル開発・型チェック・Lint/Format・デプロイ・テストの手順を記載します(Req 1.5)。

## 前提条件 (Prerequisites)

### 必要ツール

- **Node.js v24**(ビルド/スクリプト/CI のホスト実行系)
- **pnpm**(パッケージマネージャ。npm / bun は使用しない)
- **wrangler**(Cloudflare Workers のビルド・ローカル開発・デプロイ。`devDependencies` 経由で導入されるため、`pnpm` 経由で実行する)

### 必要バインディング

`wrangler.jsonc` で以下のバインディングを宣言済みです。

- **Workers AI**: `AI`(`ai.binding`)。`remote: true` のためリモートリソースです。実際に呼び出すには Cloudflare アカウントへの認証が必要です。
- **Durable Object**: `EvaluationCycleAgent` / `GoalAgent`(`durable_objects.bindings`)。`migrations.new_sqlite_classes` で SQLite 対応クラスとして宣言しています。

### Cloudflare アカウントについて

- `pnpm dev`(= `wrangler dev`)および `pnpm deploy`(= `wrangler deploy`)は、`AI` がリモートリソースであるため Cloudflare アカウントへの認証を前提とします。
- 認証情報なしでローカル起動のみ行いたい場合は、`pnpm dev --local`(= `wrangler dev --local`)を使用してください。ローカルモードでは Workers / Durable Object をローカルエミュレートします。なお `AI` バインディングはリモート専用のため、ローカルモードで AI 推論を実際に呼ぶことはできません(本基盤の疎通確認・型チェックには影響しません)。

## セットアップ (Install)

```bash
pnpm install
```

`pnpm-lock.yaml` をコミットしてください。

## ローカル開発 (Local dev)

```bash
pnpm dev
```

- 上記は `wrangler dev` を実行します。
- 起動後、ローカルサーバーは `http://localhost:8787` で待ち受けます。
- ルート(`/`)への GET は HTTP 200 を返すヘルスレスポンス(本文 `goal-agent: ok`)になります。それ以外のパスは 404 を返します。

Cloudflare の認証情報が利用できない環境では、ローカルエミュレーションで起動できます。

```bash
pnpm dev --local
```

## 型チェック (Typecheck)

```bash
pnpm typecheck
```

- 上記は `tsc --noEmit` を実行します。
- TypeScript は strict 設定で、型エラーなく完了することがプロジェクトの完了条件です(Req 1.1)。

## Lint / Format

```bash
pnpm biome check --write
```

- Biome を使用します(ESLint / Prettier は使用しない)。設定はリポジトリ直下の `biome.json` です。
- **タスク完了ゲート**: 各タスクの最後に必ず実行し、エラーが残っていないことを確認してから完了とします。`--write` で自動修正できない違反は手で直します。

## デプロイ (Deploy)

```bash
pnpm deploy
```

- 上記は `wrangler deploy` を実行します。
- デプロイには Cloudflare アカウントの認証が必要です。`wrangler login`(ブラウザ認証)、または `CLOUDFLARE_API_TOKEN` 等の API トークンを環境変数で設定してください。
- **認証情報・シークレットはコミットしません**。Cloudflare のシークレット(`wrangler secret put`)や環境変数で管理します。

## テスト (Test)

```bash
pnpm test
```

- 上記は `vitest run`(`@cloudflare/vitest-pool-workers` 利用)を実行します。
