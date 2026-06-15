// goal-management のハンドラ登録とコマンド定義集約の検証(goal-management task 4.1 /
// Req 1.1, 2.1, 3.1, 6.4)。
//
// 完了条件: `registerGoalManagement()` を呼ぶと、4 ハンドラ(cycle create / goal add /
// goal modal / evidence delete)が discord-gateway のレジストリへ識別子(コマンド名 /
// custom_id)で登録され、`lookupHandler` で各ハンドラへ正しく振り分けられる。さらに
// 3 コマンド定義(/cycle・/goal・/evidence)が集約点 `commandDefinitions` に追加される。
//
// 方針: discord-gateway の登録機構(registry / definitions)は変更せず、その公開 API を
// 呼ぶだけであることを検証する。reset 後に登録関数を明示呼び出しして状態を分離する
// (registry / definitions は module-level のデフォルトインスタンスを reset できる)。
// 実行環境: vitest projects の "node" プロジェクト(純粋な登録配線・DO 不要)。

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  commandDefinitions,
  resetCommandDefinitions,
} from "../src/discord/commands/definitions";
import {
  DuplicateHandlerError,
  lookupHandler,
  resetDefaultRegistry,
} from "../src/discord/registry";
import {
  CYCLE_COMMAND_NAME,
  EVIDENCE_COMMAND_NAME,
  GOAL_COMMAND_NAME,
  GOAL_MODAL_ID,
  goalManagementCommandDefinitions,
} from "../src/goal-management/commands";

// routing は `cloudflare:` スキーム(agents SDK / DO ルーティング)を読み込むため、node
// プロジェクトでは解決できない。本テストは登録配線のみを検証し、ハンドラ実行は行わない
// ため、routing をモックして import チェーンを断つ(他の handler テストと同じ方針)。
vi.mock("../src/goal-management/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getUserCycleAuthority: vi.fn(),
  getUserGoalAgent: vi.fn(),
}));

const { cycleCreateHandler } = await import(
  "../src/goal-management/handlers/cycle-create"
);
const { evidenceDeleteHandler } = await import(
  "../src/goal-management/handlers/evidence-delete"
);
const { goalAddHandler } = await import("../src/goal-management/handlers/goal-add");
const { goalModalSubmitHandler } = await import(
  "../src/goal-management/handlers/goal-modal-submit"
);
const { registerGoalManagement } = await import("../src/goal-management/register");

beforeEach(() => {
  resetDefaultRegistry();
  resetCommandDefinitions();
});

describe("registerGoalManagement: ハンドラ登録とコマンド定義集約", () => {
  it("4 ハンドラを識別子(コマンド名 / custom_id)でレジストリへ登録する (1.1, 2.1, 3.1, 6.4)", () => {
    registerGoalManagement();

    // command: トップレベルコマンド名で登録(dispatch は data.name で解決するため / commands.ts 注記)。
    expect(lookupHandler("command", CYCLE_COMMAND_NAME)).toBe(cycleCreateHandler);
    expect(lookupHandler("command", GOAL_COMMAND_NAME)).toBe(goalAddHandler);
    expect(lookupHandler("command", EVIDENCE_COMMAND_NAME)).toBe(evidenceDeleteHandler);
    // modal: GOAL_MODAL_ID(custom_id)で登録。
    expect(lookupHandler("modal", GOAL_MODAL_ID)).toBe(goalModalSubmitHandler);
  });

  it("3 コマンド定義を discord-gateway の集約点へ追加する (1.1, 2.1, 3.1, 6.4)", () => {
    registerGoalManagement();

    // goal-management の 3 定義(/cycle・/goal・/evidence)が集約点に含まれる。
    for (const definition of goalManagementCommandDefinitions) {
      expect(commandDefinitions).toContain(definition);
    }
    const names = commandDefinitions.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([CYCLE_COMMAND_NAME, GOAL_COMMAND_NAME, EVIDENCE_COMMAND_NAME]),
    );
  });

  it("登録後はディスパッチャ照合(lookupHandler)で各識別子が異なるハンドラへ振り分けられる (6.4)", () => {
    registerGoalManagement();

    const cycle = lookupHandler("command", CYCLE_COMMAND_NAME);
    const goal = lookupHandler("command", GOAL_COMMAND_NAME);
    const evidence = lookupHandler("command", EVIDENCE_COMMAND_NAME);
    const modal = lookupHandler("modal", GOAL_MODAL_ID);

    // 4 識別子が 4 つの異なるハンドラへ解決される(取り違えがない)。
    const handlers = [cycle, goal, evidence, modal];
    expect(handlers.every((h) => h !== null)).toBe(true);
    expect(new Set(handlers).size).toBe(4);
  });

  it("同じデフォルトレジストリへ二重登録すると DuplicateHandlerError になる(後勝ち禁止 / 6.4)", () => {
    registerGoalManagement();
    // reset せずに再登録すると重複登録として拒否される(機構の後勝ち禁止に従う)。
    expect(() => registerGoalManagement()).toThrow(DuplicateHandlerError);
  });

  it("未登録状態(register 前)ではどの識別子も解決されない", () => {
    expect(lookupHandler("command", CYCLE_COMMAND_NAME)).toBeNull();
    expect(lookupHandler("command", GOAL_COMMAND_NAME)).toBeNull();
    expect(lookupHandler("command", EVIDENCE_COMMAND_NAME)).toBeNull();
    expect(lookupHandler("modal", GOAL_MODAL_ID)).toBeNull();
    expect(commandDefinitions).toHaveLength(0);
  });
});
