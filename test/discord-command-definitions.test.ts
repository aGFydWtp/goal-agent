// コマンド定義の集約点(src/discord/commands/definitions.ts)の検証
// (Req 2.1, 2.5, 7.4 / design.md §commands "Command Definitions / Register" L455-466,
// File Structure Plan L125-127 `commands/definitions.ts`)。
//
// 完了条件(tasks 3.3): 各機能スペックが自分のコマンド定義(discord-api-types v10 の
// application command 形)を追加できる単一集約点が公開される。初期は空の集約であり、
// ゲートウェイ自身は具体的なコマンドの中身を保持しない(Req 7.4)。下位スペックが import
// して定義を追加(登録)でき、登録結果が集約へ反映される。
//
// 本テストは「空の集約点 + 追加できる構造」という最小の構造規約を検証する。
// 実行環境: vitest projects の "node" プロジェクト。

import { beforeEach, describe, expect, it } from "vitest";
import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import {
  commandDefinitions,
  registerCommandDefinition,
  resetCommandDefinitions,
} from "../src/discord/commands/definitions";

/** 下位スペックが追加する application command 形のダミー定義を作る。 */
function makeDefinition(name: string): RESTPostAPIApplicationCommandsJSONBody {
  return { name, description: `${name} command` };
}

describe("command definitions aggregation point", () => {
  beforeEach(() => {
    resetCommandDefinitions();
  });

  it("初期状態では集約が空である(ゲートウェイは具体コマンドを保持しない / Req 7.4)", () => {
    expect(commandDefinitions).toEqual([]);
  });

  it("下位スペックが import して自分のコマンド定義を追加できる(Req 2.1, 2.5)", () => {
    const def = makeDefinition("cycle");
    registerCommandDefinition(def);
    expect(commandDefinitions).toContainEqual(def);
    expect(commandDefinitions).toHaveLength(1);
  });

  it("複数スペックがそれぞれの定義を集約へ追加でき順序が保たれる", () => {
    const a = makeDefinition("alpha");
    const b = makeDefinition("beta");
    registerCommandDefinition(a);
    registerCommandDefinition(b);
    expect(commandDefinitions).toEqual([a, b]);
  });

  it("集約は application command 形の配列であり register が読み取れる形を公開する", () => {
    // 型レベルの整合: 集約要素は RESTPostAPIApplicationCommandsJSONBody として扱える。
    const aggregate: readonly RESTPostAPIApplicationCommandsJSONBody[] =
      commandDefinitions;
    expect(Array.isArray(aggregate)).toBe(true);
  });
});
