// テスト型チェック(tsconfig.test.json)専用の、Node 組み込みモジュールの最小型宣言。
//
// なぜ @types/node を使わないか:
//   @types/node を依存に加えると、その lib 参照(esnext.disposable など)が解決へ漏れ、
//   Cloudflare RPC の戻り値型(`... & Disposable`)と src の型キャスト
//   (src/agents/goal-agent.ts の `as EntityRow<E>[]`)の整合が崩れ、
//   本番 src のベース型チェック(pnpm typecheck)が壊れる。
//   本番 src を変更せずにテストだけ型チェックするため、テストが実際に使う Node 組み込み
//   API のみをここで最小宣言する(node プロジェクトの実行時型は Node ランタイムが提供)。
//
// 対象 API は test/ で実際に使用されているものに限定する:
//   - node:sqlite … helpers/node-sqlite-adapter.ts(DatabaseSync)
//   - node:fs / node:path … boundary.test.ts(readdirSync 等 / join)
//   - __dirname … boundary.test.ts

declare module "node:sqlite" {
  /** prepare で得られる文用ステートメントの最小サーフェス。 */
  interface StatementSync {
    all(...params: (string | number | null)[]): unknown[];
    run(...params: (string | number | null)[]): unknown;
  }
  /** :memory: 等を開く同期 SQLite ハンドルの最小サーフェス。 */
  class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module "node:fs" {
  interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
  }
  function readdirSync(path: string): string[];
  function readFileSync(path: string, encoding: "utf8"): string;
  function statSync(path: string): Stats;
}

declare module "node:path" {
  function join(...segments: string[]): string;
}

declare module "node:buffer" {
  // discord-verify.test.ts で使う Buffer の最小サーフェス
  //(base64url ↔ hex 変換、UTF-8 エンコード)。
  interface Buffer {
    toString(encoding: "hex" | "utf8"): string;
  }
  const Buffer: {
    from(input: string, encoding?: "base64url" | "hex" | "utf8"): Buffer;
  };
}

declare module "node:crypto" {
  // discord-verify.test.ts で使う Ed25519 鍵生成/署名の最小サーフェス。
  import type { Buffer } from "node:buffer";
  interface KeyObject {
    export(options: { format: "jwk" }): { x: string };
  }
  function generateKeyPairSync(type: "ed25519"): {
    publicKey: KeyObject;
    privateKey: KeyObject;
  };
  function sign(
    algorithm: null,
    data: Buffer,
    key: KeyObject,
  ): Buffer;
}

// CommonJS 由来のモジュール相対ディレクトリ(boundary.test.ts で使用)。
declare const __dirname: string;
