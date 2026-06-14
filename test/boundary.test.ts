// 基盤境界の機械的整合検証 (Req 6.1, 6.2, 6.3 / design.md "Boundary Commitments → Out of Boundary")。
//
// 本スイートは「基盤に境界外の責務が混入していないこと」をソースファイルの静的検査で
// 機械的に保証する(task 6.4 Part B)。型チェック/スモーク疎通(Part A)とは別に、
// 将来 downstream の責務が誤って本基盤へ混入する回帰を検出する目的を持つ。
//
// 実行環境: vitest projects の "node" プロジェクト(environment: node)。
// 本スイートは LLM/DO ランタイムを起動せず、`node:fs` でリポジトリ内のファイルを
// 読み取って文字列/依存関係を検査するだけの純粋な静的解析である。
//
// 設計方針(非脆弱性): 無害な言い回しの揺れで誤検知しないよう、
//  - 検査対象を「境界を定義する具体ファイル/具体パターン」に限定する。
//  - コメント中の「実装しない/責務外」等の説明文(=境界の宣言)を違反と誤判定
//    しないため、判定前にラインコメント/ブロックコメントを除去してから検査する。
//  - 肯定境界(基盤が所有すべき 5 レイヤの存在)も併せて確認する。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** リポジトリルート(test/ の 1 つ上)。 */
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");

/** 指定ファイルの内容を文字列で読む。 */
function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** src/ 配下の全 .ts ファイルパスを再帰収集する。 */
function collectSrcTsFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSrcTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * コメント(`// ...` 行コメント・`/* ... *\/` ブロックコメント)を除去する。
 * 本基盤のソースは「○○を実装しない」等の境界宣言をコメントで明示しているため、
 * 実コードのみを検査対象とすることで宣言文での誤検知を避ける(非脆弱性方針)。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ") // ブロックコメント
    .replace(/\/\/[^\n]*/g, " "); // 行コメント
}

/** src/ 配下サブディレクトリ名の集合。 */
function srcDirNames(): Set<string> {
  return new Set(
    readdirSync(SRC).filter((entry) => statSync(join(SRC, entry)).isDirectory()),
  );
}

describe("基盤境界: 肯定確認(基盤が所有すべきレイヤが存在する)", () => {
  // design.md "This Spec Owns" / 依存方向 types → config → persistence → llm → agents → entry。
  it("5 レイヤ(types/persistence/llm/agents)とエントリ(index.ts/env.ts)が存在する", () => {
    const dirs = srcDirNames();
    for (const layer of ["types", "persistence", "llm", "agents"]) {
      expect(dirs.has(layer), `期待レイヤ src/${layer}/ が存在しない`).toBe(true);
    }
    // Worker エントリと型付き Env。
    expect(() => statSync(join(SRC, "index.ts"))).not.toThrow();
    expect(() => statSync(join(SRC, "env.ts"))).not.toThrow();
  });
});

describe("基盤境界 6.1: Discord 署名検証・コマンドルーティングを含まない", () => {
  // Req 6.1 / "Out of Boundary": Discord interactions の Ed25519 署名検証・PING/PONG・
  // コマンドルーティング・UX 文言は discord-gateway の責務。基盤に混入してはならない。

  it("package.json の依存に Discord/署名検証ライブラリを含まない", () => {
    const pkg = JSON.parse(read(join(ROOT, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

    // Discord 署名検証/相互作用に用いられる代表的ライブラリ群。
    const forbidden = [
      "discord-interactions",
      "discord.js",
      "discord-api-types",
      "tweetnacl",
      "@discordjs/rest",
      "@discordjs/core",
    ];
    const hit = deps.filter(
      (d) => forbidden.includes(d) || d.startsWith("@discordjs/"),
    );
    expect(hit, `禁止依存が混入: ${hit.join(", ")}`).toEqual([]);
  });

  it("src/ に Discord 署名検証(verifyKey/Ed25519/interaction 検証)の実コードを含まない", () => {
    // 実コードのみ(コメント除去後)を検査する。
    const forbiddenPatterns: RegExp[] = [
      /\bverifyKey\b/, // discord-interactions の署名検証 API
      /\bEd25519\b/i, // 署名アルゴリズム
      /\bX-Signature-Ed25519\b/i, // Discord 署名ヘッダ
      /\bX-Signature-Timestamp\b/i, // Discord 署名タイムスタンプヘッダ
      /InteractionResponseType/, // Discord interactions の応答種別
      /InteractionType/, // Discord interactions の種別(PING 等)
    ];
    for (const file of collectSrcTsFiles()) {
      const code = stripComments(read(file));
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(code),
          `${file} に境界外パターン ${pattern} が混入(Req 6.1)`,
        ).toBe(false);
      }
    }
  });

  it("src/ に discord/ ディレクトリやコマンドルーティング層(handlers/)を含まない", () => {
    const dirs = srcDirNames();
    expect(dirs.has("discord"), "src/discord/ は境界外(discord-gateway 所有)").toBe(false);
    expect(dirs.has("handlers"), "src/handlers/ は境界外(下流コマンドルーティング)").toBe(false);
  });
});

describe("基盤境界 6.2: ドメイン CRUD ビジネスルールを含まない", () => {
  // Req 6.2 / "Out of Boundary": サイクル/目標/証跡の作成・更新・削除のビジネスルール、
  // §10 ステータス判定ルール、分類スコアリングは goal-management / status-and-draft 所有。
  // リポジトリは generic CRUD、Agent はデータ権威 passthrough + 委譲のみ。

  it("repository.ts はステータス判定/分類スコアリング等のドメインロジックを含まない", () => {
    const code = stripComments(read(join(SRC, "persistence", "repository.ts")));
    // §10 ステータス色(green/yellow/red)の判定や分類スコアリングのロジック名が
    // 実コードに現れないこと(generic 行アクセスのみであることの担保)。
    const forbiddenPatterns: RegExp[] = [
      /["'`](green|yellow|red)["'`]/, // ステータス色リテラルでの判定(§10)
      /\bdetermineStatus\b/i,
      /\bclassify\w*\b/i, // チェックイン分類スコアリング
      /\bscore\w*\(/i, // 分類スコアリング関数
      /\btransition\w*\b/i, // 状態遷移ルール
      /\bvalidate\w*Goal\b/i, // 目標ドメイン妥当性検証
    ];
    for (const pattern of forbiddenPatterns) {
      expect(
        pattern.test(code),
        `repository.ts にドメインルール ${pattern} が混入(Req 6.2)`,
      ).toBe(false);
    }
  });

  it("Agent クラスはデータ権威 passthrough/委譲を超えるドメインメソッドを含まない", () => {
    const agentFiles = [
      join(SRC, "agents", "evaluation-cycle-agent.ts"),
      join(SRC, "agents", "goal-agent.ts"),
    ];
    // 基盤の Agent が公開してよいデータサーフェス(generic 行アクセスの委譲入口)。
    // これら以外のドメイン操作名(目標作成/分類/ステータス判定/評価文生成)は境界外。
    const forbiddenPatterns: RegExp[] = [
      /\bcreateGoal\b/i,
      /\bupdateGoal\b/i,
      /\bclassifyCheckin\b/i,
      /\bdetermineStatus\b/i,
      /\bgenerate\w*(Draft|Review|Evaluation)\b/i, // §13.3 評価文生成等
      /["'`](green|yellow|red)["'`]/, // §10 ステータス判定
    ];
    for (const file of agentFiles) {
      const code = stripComments(read(file));
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(code),
          `${file} に境界外ドメインメソッド ${pattern} が混入(Req 6.2)`,
        ).toBe(false);
      }
    }
  });
});

describe("基盤境界 6.3: 機能固有プロンプト/出力スキーマを含まない", () => {
  // Req 6.3 / "Out of Boundary": チェックイン分類(§13.1)・ステータス判定・評価文生成(§13.3)
  // の各プロンプト本文と機能固有の構造化出力スキーマは checkin-classification / status-and-draft 所有。
  // 基盤 LLM 層は generic 抽象のみ(completeJson はスキーマを「引数」として受け取る)。

  it("src/llm/ は機能固有プロンプト本文を埋め込まない", () => {
    for (const file of collectSrcTsFiles(join(SRC, "llm"))) {
      const code = stripComments(read(file));
      // §13 プロンプト本文に現れる機能固有の日本語/英語ドメイン語(分類・ステータス判定・
      // 評価文生成)が実コードのプロンプト文字列として現れないこと。
      const forbiddenPatterns: RegExp[] = [
        /チェックイン/, // §13.1 分類プロンプト本文
        /分類/, // 分類指示
        /ステータス(を)?(判定|評価)/, // §10/§13 ステータス判定プロンプト
        /評価文/, // §13.3 評価文生成プロンプト
        /relevance_score/, // 機能固有出力フィールド
        /usefulness/, // 機能固有出力フィールド
      ];
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(code),
          `${file} に機能固有プロンプト/語 ${pattern} が混入(Req 6.3)`,
        ).toBe(false);
      }
    }
  });

  it("src/llm/ は機能固有の zod 出力スキーマを定義しない(スキーマは呼び出し側が渡す)", () => {
    for (const file of collectSrcTsFiles(join(SRC, "llm"))) {
      const code = stripComments(read(file));
      // 基盤の completeJson はスキーマを「引数」として受け取る契約であり、
      // 自前で z.object(...) 等の具体スキーマ本体を定義してはならない。
      // (型としての ZodType import は許容。スキーマ「構築」のみを禁止する。)
      const forbiddenPatterns: RegExp[] = [
        /\bz\.object\s*\(/, // 具体スキーマ構築
        /\bz\.enum\s*\(/,
        /\bz\.string\s*\(/,
        /\bz\.number\s*\(/,
      ];
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(code),
          `${file} に機能固有 zod スキーマ構築 ${pattern} が混入(Req 6.3)`,
        ).toBe(false);
      }
    }
  });
});
