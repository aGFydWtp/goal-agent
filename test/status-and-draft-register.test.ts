// status-and-draft のハンドラ登録とコマンド定義集約 / 統合の検証 (task 6.3 /
// Req 2.1, 3.1, 4.1, 5.1, 8.3, 8.4)。
//
// 完了条件: `registerGoalManagement()` → `registerStatusAndDraft()` の順で呼ぶと、
//  - /status・/goal status・/evidence list・/draft の 4 コマンドハンドラが discord-gateway の
//    レジストリへ規約適合(dispatch の結合キー / トップレベル名)で登録され、
//  - 4 種の調整ボタン・保存ボタンが動的 custom_id 接頭辞で登録され、
//  - status-and-draft のコマンド定義(/status・/draft)が集約点 `commandDefinitions` に追加され、
//    かつ /goal status・/evidence list は goal-management 所有の goal・evidence 定義へ
//    `status`・`list` サブコマンドが「登録時マージ」される(goal-management ソースは不変、
//    エクスポート singleton は変更しない=クローンする)。
//
// dispatch の解決規約(src/discord/dispatch.ts L202-209): command は最具体優先で
// 結合キー `"<top-level> <subcommand>"` を先に照合し、無ければトップレベル名へフォールバック
// する。したがって `/goal status` は "goal status"、`/evidence list` は "evidence list"、
// `/status`・`/draft` はトップレベル名で登録するのが規約適合となる。
//
// 方針: discord-gateway の登録機構(registry / definitions)は変更せず、その公開 API を
// 呼ぶだけであることを検証する。reset 後に登録関数を明示呼び出しして状態を分離する。
// 実行環境: vitest projects の "node" プロジェクト(純粋な登録配線・DO 不要)。
//
// routing は `agents` パッケージ(DO ルーティング)を読み込むため node プロジェクトでは
// 解決できない。本テストは登録配線のみを検証しハンドラ実行は行わないため、routing を
// モックして import チェーンを断つ(他の register / handler テストと同じ方針)。

import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("../src/goal-management/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getUserCycleAuthority: vi.fn(),
  getUserGoalAgent: vi.fn(),
}));

vi.mock("../src/status-and-draft/routing", () => ({
  getDraftEphemeralKv: vi.fn(),
  persistPendingDraft: vi.fn(),
  hydratePendingDraftStore: vi.fn(),
}));

import {
  commandDefinitions,
  resetCommandDefinitions,
} from "../src/discord/commands/definitions";
import { lookupHandler, resetDefaultRegistry } from "../src/discord/registry";
import {
  EVIDENCE_COMMAND_NAME,
  GOAL_COMMAND_NAME,
  goalManagementCommandDefinitions,
} from "../src/goal-management/commands";

const { registerGoalManagement } = await import("../src/goal-management/register");
const { registerStatusAndDraft } = await import("../src/status-and-draft/register");

const {
  DRAFT_COMMAND_NAME,
  EVIDENCE_LIST_SUBCOMMAND,
  GOAL_STATUS_SUBCOMMAND,
  STATUS_COMMAND_NAME,
} = await import("../src/status-and-draft/commands");
const { buildRefineButtonId, buildSaveDraftButtonId } = await import(
  "../src/status-and-draft/custom-ids"
);

const { statusCommandHandler } = await import(
  "../src/status-and-draft/handlers/status-command"
);
const { goalStatusCommandHandler } = await import(
  "../src/status-and-draft/handlers/goal-status-command"
);
const { evidenceListCommandHandler } = await import(
  "../src/status-and-draft/handlers/evidence-list-command"
);
const { draftCommandHandler } = await import(
  "../src/status-and-draft/handlers/draft-command"
);
const { refineButtonHandler } = await import(
  "../src/status-and-draft/handlers/refine-button"
);
const { saveDraftButtonHandler } = await import(
  "../src/status-and-draft/handlers/save-draft-button"
);

const GOAL_STATUS_KEY = `${GOAL_COMMAND_NAME} ${GOAL_STATUS_SUBCOMMAND}`; // "goal status"
const EVIDENCE_LIST_KEY = `${EVIDENCE_COMMAND_NAME} ${EVIDENCE_LIST_SUBCOMMAND}`; // "evidence list"

beforeEach(() => {
  resetDefaultRegistry();
  resetCommandDefinitions();
});

describe("registerStatusAndDraft: ハンドラ登録・ボタン接頭辞・定義マージ", () => {
  it("4 コマンドハンドラを規約適合キーで登録する (2.1, 3.1, 4.1, 5.1)", () => {
    registerGoalManagement();
    registerStatusAndDraft();

    // /status・/draft はトップレベル名で登録(結合キーなし)。
    expect(lookupHandler("command", STATUS_COMMAND_NAME)).toBe(statusCommandHandler);
    expect(lookupHandler("command", DRAFT_COMMAND_NAME)).toBe(draftCommandHandler);
    // /goal status・/evidence list は dispatch の結合キーで登録。
    expect(lookupHandler("command", GOAL_STATUS_KEY)).toBe(goalStatusCommandHandler);
    expect(lookupHandler("command", EVIDENCE_LIST_KEY)).toBe(evidenceListCommandHandler);
  });

  it("goal-management の既存コマンドハンドラ(後方互換)を壊さない (8.3)", () => {
    registerGoalManagement();
    registerStatusAndDraft();

    // goal/evidence のトップレベルは goal-management のハンドラへフォールバックで解決される
    // (/goal add・/evidence delete は結合キー未登録 → トップレベル名で解決)。
    const goalTop = lookupHandler("command", GOAL_COMMAND_NAME);
    const evidenceTop = lookupHandler("command", EVIDENCE_COMMAND_NAME);
    expect(goalTop).not.toBeNull();
    expect(evidenceTop).not.toBeNull();
    // status-and-draft のハンドラとは別物(取り違えがない)。
    expect(goalTop).not.toBe(goalStatusCommandHandler);
    expect(evidenceTop).not.toBe(evidenceListCommandHandler);
  });

  it("4 種の調整ボタンと保存ボタンを動的 custom_id 接頭辞で登録する (6.1-6.4, 7.1 / 8.4)", () => {
    registerGoalManagement();
    registerStatusAndDraft();

    // 4 種の調整ボタンは draftPendingId 埋め込みの動的 custom_id → refineButtonHandler へ解決。
    expect(lookupHandler("component", buildRefineButtonId("shorten", "p1"))).toBe(
      refineButtonHandler,
    );
    expect(lookupHandler("component", buildRefineButtonId("strengthen", "p1"))).toBe(
      refineButtonHandler,
    );
    expect(lookupHandler("component", buildRefineButtonId("clarify", "p1"))).toBe(
      refineButtonHandler,
    );
    expect(lookupHandler("component", buildRefineButtonId("manager", "p1"))).toBe(
      refineButtonHandler,
    );
    // 保存ボタンは saveDraftButtonHandler へ解決。
    expect(lookupHandler("component", buildSaveDraftButtonId("p1"))).toBe(
      saveDraftButtonHandler,
    );
  });

  it("/status・/draft の定義を集約点へ追加する (2.1, 5.1)", () => {
    registerGoalManagement();
    registerStatusAndDraft();

    const names = commandDefinitions.map((d) => d.name);
    expect(names).toContain(STATUS_COMMAND_NAME);
    expect(names).toContain(DRAFT_COMMAND_NAME);
  });

  it("goal 定義へ status を、evidence 定義へ list をマージする(登録時マージ / 8.3, 8.4)", () => {
    registerGoalManagement();
    registerStatusAndDraft();

    const goalDef = commandDefinitions.find((d) => d.name === GOAL_COMMAND_NAME);
    const evidenceDef = commandDefinitions.find((d) => d.name === EVIDENCE_COMMAND_NAME);
    expect(goalDef).toBeDefined();
    expect(evidenceDef).toBeDefined();

    const goalSubNames = (goalDef?.options ?? []).map((o) => o.name);
    const evidenceSubNames = (evidenceDef?.options ?? []).map((o) => o.name);
    // goal は add(goal-management)と status(status-and-draft)の両方を持つ。
    expect(goalSubNames).toEqual(expect.arrayContaining(["add", GOAL_STATUS_SUBCOMMAND]));
    // evidence は delete(goal-management)と list(status-and-draft)の両方を持つ。
    expect(evidenceSubNames).toEqual(
      expect.arrayContaining(["delete", EVIDENCE_LIST_SUBCOMMAND]),
    );
  });

  it("マージは goal-management のエクスポート singleton を変更しない(クローン)(8.3)", () => {
    registerGoalManagement();
    registerStatusAndDraft();

    // goal-management が export する元定義(singleton)はサブコマンドを増やされていない。
    const sourceGoal = goalManagementCommandDefinitions.find(
      (d) => d.name === GOAL_COMMAND_NAME,
    );
    const sourceEvidence = goalManagementCommandDefinitions.find(
      (d) => d.name === EVIDENCE_COMMAND_NAME,
    );
    expect((sourceGoal?.options ?? []).map((o) => o.name)).toEqual(["add"]);
    expect((sourceEvidence?.options ?? []).map((o) => o.name)).toEqual(["delete"]);
  });

  it("reset + 再登録を繰り返してもサブコマンドが重複蓄積しない(冪等)(8.3)", () => {
    registerGoalManagement();
    registerStatusAndDraft();

    resetDefaultRegistry();
    resetCommandDefinitions();

    registerGoalManagement();
    registerStatusAndDraft();

    const goalDef = commandDefinitions.find((d) => d.name === GOAL_COMMAND_NAME);
    const goalSubNames = (goalDef?.options ?? []).map((o) => o.name);
    // status が一度だけ(重複なし)。
    expect(goalSubNames.filter((n) => n === GOAL_STATUS_SUBCOMMAND)).toHaveLength(1);
    expect(goalSubNames.filter((n) => n === "add")).toHaveLength(1);
  });
});
