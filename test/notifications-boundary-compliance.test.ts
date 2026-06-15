// notifications 境界遵守(上流契約の消費)の機械的検証 (task 7.2 / Req 7.1, 7.2, 7.3, 7.4)。
//
// 本スイートは「notifications が上流の確立した契約を *消費* し、判定/配信/基盤を *再実装*
// しておらず、かつ将来枠機能(/checkin 会話処理・Google Calendar 連携・/prepare 1on1)を
// 含まないこと」を、src/notifications/ 配下ソースの静的検査で機械的に保証する。
//
// 既存の test/boundary.test.ts(infra-foundation 自レイヤの境界ガード)とは検査対象が異なる:
//  - boundary.test.ts: 基盤レイヤ(types/persistence/llm/agents)へ下流責務が混入しない回帰を防ぐ。
//  - 本スイート: 下流スペック notifications が上流契約を import 経由で消費し、判定/配信/基盤を
//    自前再実装しない & 将来枠機能を持たないことを確認する。両者は補完関係にあり重複しない。
//
// 実行環境: vitest projects の "node" プロジェクト(environment: node)。LLM/DO ランタイムを
// 起動せず、`node:fs` でリポジトリ内ファイルを読み取り文字列/依存関係を検査する純粋な静的解析。
//
// 設計方針(非脆弱性):
//  - 「消費」は import エッジの存在で確認する(具体ファイル・具体シンボルに限定)。
//  - 「非再実装/不在」は判定前にコメントを除去した *実コード* に対して、誤検知しない精密な
//    マーカーで検査する(例: 週次チェックイン通知の語 "checkin" は正当なので、禁止対象は
//    会話処理を示す具体識別子に限定する)。各「不在」判定の選定理由はコメントで明示する。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** リポジトリルート(test/ の 1 つ上)。 */
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
/** 検査対象スペック(notifications)のソースルート。 */
const NOTIF = join(SRC, "notifications");

/** 指定ファイルの内容を文字列で読む。 */
function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** 指定ディレクトリ配下の全 .ts ファイルパスを再帰収集する。 */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * コメント(`// ...` 行コメント・`/* ... *\/` ブロックコメント)を除去する。
 * notifications のソースは「○○を再実装しない/委譲する」等の境界宣言を JSDoc/コメントで
 * 明示しているため、実コードのみを検査対象とし宣言文での誤検知を避ける(非脆弱性方針)。
 */
function stripComments(source: string): string {
  // 行コメントを先に除去する。notifications のヘッダコメントは行コメント中に `src/agents/*.ts`
  // のような `/*` 並びを含むため、ブロックコメント除去を先に行うと行コメント内の擬似 `/*` が
  // 後続の `*/` まで貪欲に巻き込み import 文を誤って消す。行コメント→ブロックコメントの順で
  // 除去することでこの誤検知を防ぐ(非脆弱性方針)。
  return source
    .replace(/\/\/[^\n]*/g, " ") // 行コメント
    .replace(/\/\*[\s\S]*?\*\//g, " "); // ブロックコメント / JSDoc
}

/** src/notifications/ 配下の全 .ts ファイル(実在前提)。 */
function notificationSrcFiles(): string[] {
  const files = collectTsFiles(NOTIF);
  // 前提担保: 検査対象が空(=モジュール未生成)なら検査自体が無意味なので明示的に失敗させる。
  expect(files.length, "src/notifications/ に .ts ファイルが存在しない").toBeGreaterThan(0);
  return files;
}

/** src/notifications/ 配下の実コード(コメント除去後)を 1 つに連結した文字列。 */
function notificationCode(): string {
  return notificationSrcFiles()
    .map((f) => stripComments(read(f)))
    .join("\n");
}

/**
 * notifications 配下に「指定シンボルを指定モジュールパスから import する文」が存在するか。
 *
 * 連結文字列に対する lazy 正規表現は import 文境界を跨いで誤マッチしうるため、各 import 文を
 * 単位に分解して厳密に判定する( named/aliased import・複数行 import の双方を許容)。
 *
 * @param symbol import される名前(named。`as` エイリアスでも元名で照合)。
 * @param modulePathFragment import 元モジュールパスに含まれるべき部分文字列(例: status-and-draft/domain/status-operations)。
 */
function hasImportOf(symbol: string, modulePathFragment: string): boolean {
  const code = notificationCode();
  // `import ... from "..."` を 1 文ずつ取り出す(複数行 import を許容)。
  const importStmt = /import\b[\s\S]*?from\s+["']([^"']+)["']/g;
  const symbolWord = new RegExp(`\\b${symbol}\\b`);
  for (let m = importStmt.exec(code); m !== null; m = importStmt.exec(code)) {
    const [stmt, modulePath] = m;
    if (modulePath.includes(modulePathFragment) && symbolWord.test(stmt)) {
      return true;
    }
  }
  return false;
}

describe("notifications 境界 7.1: ステータス判定は status-and-draft を消費し再実装しない", () => {
  // Req 7.1 / design「Out of Boundary: StatusVerdict 算出は status-and-draft 所有。本スペックは
  // determineAllStatuses/determineGoalStatus を呼ぶのみ」。

  it("status-and-draft の判定メソッド(determineAllStatuses)を import 経由で消費する", () => {
    // 上流判定契約の消費(import エッジ)を確認する。design では determineAllStatuses を主消費とする。
    expect(
      hasImportOf("determineAllStatuses", "status-and-draft/domain/status-operations"),
      "notifications が status-and-draft の determineAllStatuses を import していない(Req 7.1)",
    ).toBe(true);
  });

  it("ステータス判定ロジック本体(StatusVerdict 算出・判定スキーマ)を再実装/再 import しない", () => {
    // 「再実装しない」を精密に検査する。notifications は確定済み `verdict.status` を *数える* のみ
    // (countStatuses)で許容される。禁止するのは「自前の判定関数定義」と「判定の内部実装/スキーマの
    // 再 import(判定を自前で組み直す兆候)」である。
    for (const file of notificationSrcFiles()) {
      const code = stripComments(read(file));

      // (a) 自前のステータス判定関数を *定義* しない。
      //     determineGoalStatus/determineAllStatuses/determineStatus/computeStatus/judgeStatus 等を
      //     notifications 内で function 定義してはならない(上流のものは import して呼ぶ)。
      const forbiddenDefs: RegExp[] = [
        /\bfunction\s+determine(Goal|All)?Status\w*\s*\(/i,
        /\bfunction\s+(compute|judge|evaluate|derive|classify)\w*Status\b/i,
        /\bfunction\s+buildStatusVerdict\b/i,
      ];
      for (const pattern of forbiddenDefs) {
        expect(
          pattern.test(code),
          `${file} に自前ステータス判定関数定義 ${pattern} が混入(Req 7.1 再実装禁止)`,
        ).toBe(false);
      }

      // (b) 判定の *内部実装* / LLM 判定スキーマを再 import しない。
      //     許容: 判定結果の型(StatusVerdict / DetermineAllStatusesResult)の import と
      //     判定エントリ関数 determineAllStatuses/determineGoalStatus の import。
      //     禁止: status-and-draft の status/schema(判定スキーマ本体)や judgment 内部の取り込み。
      const forbiddenImports: RegExp[] = [
        /from\s+["'][^"']*status-and-draft\/status\/schema["']/, // 判定スキーマ本体
        /\bstatusVerdictLlmSchema\b/, // §13.2 LLM 判定スキーマ識別子
      ];
      for (const pattern of forbiddenImports) {
        expect(
          pattern.test(code),
          `${file} に判定内部実装/スキーマ ${pattern} の取り込みが混入(Req 7.1 再実装禁止)`,
        ).toBe(false);
      }
    }
  });
});

describe("notifications 境界 7.2: 配信は discord-gateway の送信ヘルパーを消費し REST を再実装しない", () => {
  // Req 7.2 / design「Out of Boundary: DM open・403 フォールバックの REST 実装は discord-gateway 所有。
  // 本スペックは sendDirectMessage を呼ぶのみ」。

  it("discord-gateway の sendDirectMessage を delivery 経由で import 消費する", () => {
    expect(
      hasImportOf("sendDirectMessage", "discord/proactive"),
      "notifications が discord-gateway の sendDirectMessage を import していない(Req 7.2)",
    ).toBe(true);
  });

  it("notifications 配下に生の Discord REST/DM 呼び出し(fetch・API ベース URL・messages エンドポイント)を含まない", () => {
    // discord-gateway(src/discord/rest.ts)が所有する REST 機構の兆候を notifications が *自前で*
    // 持たないことを確認する。禁止マーカーは rest.ts の実装に現れる具体物に限定する。
    const forbiddenPatterns: RegExp[] = [
      /https?:\/\/discord\.com\/api/i, // Discord REST のベース URL
      /\/channels\/[^"'`/]*\/messages/, // POST /channels/{id}/messages(DM/チャンネル送信)
      /\/users\/@me\/channels/, // DM オープン(createDM)
      /\bfetch\s*\(/, // 生 fetch(配信は sendDirectMessage 経由のみ)
      /\bAuthorization\b\s*:\s*[`"']?Bot\b/, // Bot トークン認証ヘッダ(REST 自前実装の兆候)
      /@discordjs\//, // 重量級 Discord スタック
      /\bdiscord\.js\b/,
    ];
    for (const file of notificationSrcFiles()) {
      const code = stripComments(read(file));
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(code),
          `${file} に生の Discord REST/DM 機構 ${pattern} が混入(Req 7.2 再実装禁止)`,
        ).toBe(false);
      }
    }
  });
});

describe("notifications 境界 7.3: 基盤/スキーマ/LLM は infra-foundation を消費し再定義しない", () => {
  // Req 7.3 / design「Out of Boundary: §11 スキーマ・Repository 実装・this.schedule() 基盤・
  // LlmClient は infra-foundation 所有」。

  it("マイグレーション適用は infra の runMigrations を再利用する(ランナーを再実装しない)", () => {
    // state/migrations.ts は適用ロジックを再実装せず、infra の runMigrations へ Migration 配列を
    // 渡す(design「適用ロジックは infra の runMigrations を再利用する」)。import エッジで確認する。
    expect(
      hasImportOf("runMigrations", "persistence/migrator"),
      "notifications が infra の runMigrations を import していない(Req 7.3)",
    ).toBe(true);
  });

  it("基盤プリミティブ(Repository/SqlLike/migrator/LLM クライアント)を自前定義/構築しない", () => {
    // 許容: infra が公開する型/関数の import 消費(Repository 型・SqlLike 型・runMigrations 関数・
    // LlmClient 型)。禁止: notifications 内でそれらを *再定義/再構築* すること。
    for (const file of notificationSrcFiles()) {
      const code = stripComments(read(file));
      const forbiddenPatterns: RegExp[] = [
        // 基盤 Repository / マイグレーションランナー / LLM クライアントの自前ファクトリ定義。
        /\bfunction\s+createRepository\b/, // infra のリポジトリ生成を再定義しない
        /\bfunction\s+runMigrations\b/, // infra のランナーを再定義しない
        /\bfunction\s+createLlmClient\b/, // infra の LLM クライアント生成を再定義しない
        /\bnew\s+(OpenAI|Anthropic)\b/, // LLM SDK クライアントの自前生成(基盤責務)
        // 定期実行(cron/alarm)機構の自前実装。this.schedule() は infra 基盤の提供物。
        /\bnew\s+CronJob\b/,
        /\brequire\(\s*["']node-cron["']\s*\)/,
        /from\s+["'](node-cron|croner|cron)["']/, // cron ライブラリ取り込み
        /\bsetInterval\s*\(/, // 自前ポーリングによる定期実行機構
      ];
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(code),
          `${file} に基盤プリミティブの再定義/再構築 ${pattern} が混入(Req 7.3 再定義禁止)`,
        ).toBe(false);
      }
    }
  });
});

describe("notifications 境界 7.4: 将来枠/対象外機能(checkin 会話・Calendar・/prepare 1on1)を実装しない", () => {
  // Req 7.4 / design「Out of Boundary: /checkin の会話処理・分類・証跡化(checkin-classification)
  // および Google Calendar 連携・/prepare 1on1(将来枠)は実装しない」。
  //
  // 非脆弱性の要点: 週次チェックイン *通知* の語("checkin"/"チェックイン")は本スペックの正当な
  // 責務であり禁止しない。禁止対象は「/checkin 会話の分類・証跡化」「Google Calendar 連携」
  // 「/prepare 1on1」を示す具体識別子に限定する。

  it("checkin-classification(会話分類・証跡化)を実装しない", () => {
    for (const file of notificationSrcFiles()) {
      const code = stripComments(read(file));
      const forbiddenPatterns: RegExp[] = [
        /\bcheckin-classification\b/i, // 当該スペック名(別スペック所有)
        /\bclassify\w*\b/i, // 分類スコアリング(checkin-classification 所有)
        /\bclassification\b/i, // 分類責務
        /relevance_score/, // §13.1 分類出力フィールド
        /\busefulness\b/i, // §13.1 分類出力フィールド
      ];
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(code),
          `${file} に checkin 会話分類/証跡化 ${pattern} が混入(Req 7.4 将来枠/対象外)`,
        ).toBe(false);
      }
    }
  });

  it("Google Calendar 連携を実装しない", () => {
    for (const file of notificationSrcFiles()) {
      const code = stripComments(read(file));
      const forbiddenPatterns: RegExp[] = [
        /\bcalendar\b/i, // Google Calendar 連携(§9.2 将来枠)
        /googleapis/i, // Google API クライアント
        /\bgcal\b/i,
      ];
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(code),
          `${file} に Google Calendar 連携 ${pattern} が混入(Req 7.4 将来枠)`,
        ).toBe(false);
      }
    }
  });

  it("/prepare 1on1 機能を実装しない", () => {
    for (const file of notificationSrcFiles()) {
      const code = stripComments(read(file));
      const forbiddenPatterns: RegExp[] = [
        /\b1on1\b/i, // /prepare 1on1(§9.2 将来枠)
        /\b1-on-1\b/i,
        /\bprepare1on1\b/i,
        /["'`]\/prepare\b/, // /prepare slash command 文字列
      ];
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(code),
          `${file} に /prepare 1on1 機能 ${pattern} が混入(Req 7.4 将来枠)`,
        ).toBe(false);
      }
    }
  });

  it("新規 slash command 定義(コマンドルーティング)を追加しない", () => {
    // design「本スペックは新規 slash command を追加しないため、discord-gateway の commandDefinitions
    // 集約点へは追加しない」。notifications は定期発火起点のみで、コマンド定義を持たない。
    for (const file of notificationSrcFiles()) {
      const code = stripComments(read(file));
      const forbiddenPatterns: RegExp[] = [
        /\bcommandDefinitions\b/, // discord-gateway のコマンド集約点(下流コマンド追加の兆候)
        /\bSlashCommandBuilder\b/,
      ];
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(code),
          `${file} に新規 slash command 定義 ${pattern} が混入(Req 7.4 / design: 新規コマンド追加なし)`,
        ).toBe(false);
      }
    }
  });
});
