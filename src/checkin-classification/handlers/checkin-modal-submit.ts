// checkin modal submit ハンドラ(checkin-classification Checkin Modal Submit Handler /
// Req 1.3, 1.4, 2.6, 2.7, 3.1, 3.2, 3.6)。
//
// design「分類(deferred)→ 確認提示」フローに従う薄層:
// 1. modal の複数行 TextInput(CHECKIN_INPUT_FIELD_ID)から raw テキストを読む。
// 2. 空入力ガード(verify)。空なら ephemeral 通知(分類フローを開始しない / Req 1.4)。
// 3. 入力ありなら deferred(ephemeral, type5)を 3 秒以内に返し、分類を waitUntil 継続で実行
//    (Req 2.7)。
// 4. 分類成功で確認メッセージ(§14.1)+ [保存]/[修正]/[破棄] ボタン(custom_id に pendingId)を
//    follow-up。pending 分類は infra 揮発 KV に保持(routing ブリッジ)。失敗で再試行案内を
//    follow-up し、証跡は作らない(Req 2.6, 3.1, 3.2)。
//
// ビジネスルール(対象サイクル解決・分類・検証・pending 保持)はドメイン層へ委譲し、ハンドラは
// 入出力変換と応答整形のみを担う。全応答は ephemeral(Req 1.5, 3.6)。
//
// 依存方向: handlers → custom-ids / messages / routing / domain / goal-management routing /
// llm factory(左方向のみ)。

import type {
  APIModalSubmitInteraction,
  ModalSubmitActionRowComponent,
  ModalSubmitComponent,
} from "discord-api-types/v10";

import type { DiscordEnv } from "../../discord/env";
import type {
  Followup,
  HandlerResult,
  InteractionContext,
  InteractionHandler,
  MessageActionRow,
} from "../../discord/types";
import { defaultDeps, listGoals } from "../../goal-management/domain/cycle-operations";
import { getUserCycleAuthority } from "../../goal-management/routing";
import { createLlmClient } from "../../llm/factory";
import {
  buildCheckinDiscardButtonId,
  buildCheckinEditButtonId,
  buildCheckinSaveButtonId,
  CHECKIN_INPUT_FIELD_ID,
} from "../custom-ids";
import type { ClassifyCheckinResult } from "../domain/checkin-operations";
import {
  classifyCheckin,
  createPendingCheckinStore,
  resolveCheckinActiveCycle,
} from "../domain/checkin-operations";
import { formatClassificationConfirmation } from "../messages";
import { getCheckinEphemeralKv, persistPendingClassification } from "../routing";

// Discord modal action row / text input の component type 値(数値リテラル / workerd enum 問題回避)。
const ACTION_ROW = 1; // ComponentType.ActionRow
const TEXT_INPUT = 4; // ComponentType.TextInput

// message component button のスタイル値(types.ts: 1=Primary / 2=Secondary / 3=Success / 4=Danger)。
const STYLE_SUCCESS = 3; // [保存]
const STYLE_SECONDARY = 2; // [修正]
const STYLE_DANGER = 4; // [破棄]

/**
 * 分類失敗の判別共用体を tail 用の 1 行文字列へ整形する。
 * goalId は件数のみ出し、実在しない id の中身はログに残さない。
 */
function describeFailure(result: Extract<ClassifyCheckinResult, { ok: false }>): string {
  if (result.reason === "classification_failed") {
    if ("verificationReason" in result) {
      return `reason=classification_failed verification=${result.verificationReason} goalIdCount=${result.goalIds.length}`;
    }
    return `reason=classification_failed errorKind=${result.errorKind}`;
  }
  return `reason=${result.reason}`;
}

/** 空入力時の ephemeral 通知(分類フローを開始しない / Req 1.4)。 */
const EMPTY_INPUT_NOTICE = "入力が空でした。今週やったことを入力してから送信してください。";

/** 分類失敗時の再試行案内(証跡は作らない / Req 2.6)。 */
const CLASSIFICATION_FAILED_NOTICE =
  "分類に失敗しました。お手数ですが、もう一度 `/checkin` から入力し直してください。";

/** 対象サイクルが解決できない場合の案内(Req 1.2 相当の防御)。 */
const NO_CYCLE_NOTICE =
  "アクティブな評価サイクルが見つかりませんでした。先に `/cycle create` でサイクルを作成してください。";

/**
 * modal submit payload の action row 群を走査し、各 text input の custom_id → value を引く。
 * 規約外の component(action row / text input 以外)は無視する。
 */
function buildFieldLookup(ctx: InteractionContext): Map<string, string> {
  const interaction = ctx.raw as APIModalSubmitInteraction;
  const lookup = new Map<string, string>();
  const rows = interaction.data.components;
  if (rows === undefined) {
    return lookup;
  }
  for (const row of rows) {
    if (row.type !== ACTION_ROW) {
      continue;
    }
    for (const component of componentsOf(row)) {
      if (component.type === TEXT_INPUT && typeof component.value === "string") {
        lookup.set(component.custom_id, component.value);
      }
    }
  }
  return lookup;
}

/** action row が内包する component 群を取り出す(無ければ空配列)。 */
function componentsOf(row: ModalSubmitActionRowComponent): readonly ModalSubmitComponent[] {
  return row.components ?? [];
}

/** [保存]/[修正]/[破棄] ボタンを 1 行に並べた message action row を組み立てる(Req 3.2)。 */
function confirmationButtonRow(pendingId: string): MessageActionRow {
  return {
    type: 1,
    components: [
      {
        type: 2,
        custom_id: buildCheckinSaveButtonId(pendingId),
        label: "保存",
        style: STYLE_SUCCESS,
      },
      {
        type: 2,
        custom_id: buildCheckinEditButtonId(pendingId),
        label: "修正",
        style: STYLE_SECONDARY,
      },
      {
        type: 2,
        custom_id: buildCheckinDiscardButtonId(pendingId),
        label: "破棄",
        style: STYLE_DANGER,
      },
    ],
  };
}

/**
 * 分類を実行し、結果を follow-up で送る deferred 継続(Req 2.7, 3.1, 3.2)。
 *
 * 対象サイクル解決 → 分類(listGoals + LLM + 検証)→ pending 保持 → 確認メッセージ + 3 ボタンを
 * editOriginal で送る。失敗(no_cycle / 空入力 / 分類失敗)は再試行案内へ正規化する。
 */
async function runClassification(
  env: DiscordEnv,
  userId: string,
  rawText: string,
  followup: Followup,
): Promise<void> {
  const authority = await getUserCycleAuthority(env, userId);
  const resolved = await resolveCheckinActiveCycle(authority, userId);
  if (!resolved.ok) {
    await followup.editOriginal(NO_CYCLE_NOTICE);
    return;
  }

  const store = createPendingCheckinStore();
  const result = await classifyCheckin(authority, defaultDeps(), createLlmClient(env), store, {
    userId,
    cycleId: resolved.cycle.id,
    rawText,
  });
  if (!result.ok) {
    // 失敗理由を tail で判別可能にする(ユーザー応答は汎用文言のまま / Req 2.6)。
    // 生の入力テキストは出さず、列挙値の理由のみをログする。
    console.error(`checkin.classify: 分類失敗 userId=${userId} ${describeFailure(result)}`);
    await followup.editOriginal(CLASSIFICATION_FAILED_NOTICE);
    return;
  }

  // pending 分類をリクエスト跨ぎで保持(infra 揮発 KV / 確定操作ボタンが pendingId で引く)。
  const pending = store.classifications.get(result.pendingId);
  if (pending === undefined) {
    // 直前に保持したはずの pending が無いのは想定外。証跡は作らず再試行案内へ正規化する。
    await followup.editOriginal(CLASSIFICATION_FAILED_NOTICE);
    return;
  }
  const kv = await getCheckinEphemeralKv(env, userId);
  await persistPendingClassification(kv, pending);

  // 確認メッセージの目標ラベル(id→title)を解決する。分類は実在 goalId のみ残すため、
  // ラベルは対象サイクルの目標一覧から引く。
  const goals = await listGoals(authority, userId, resolved.cycle.id);
  const confirmation = formatClassificationConfirmation(
    result.result,
    goals.map((goal) => ({ id: goal.id, title: goal.title })),
  );

  await followup.editOriginal(confirmation, {
    components: [confirmationButtonRow(result.pendingId)],
  });
}

/**
 * checkin modal submit ハンドラ(Req 1.3, 1.4, 2.6, 2.7, 3.1, 3.2, 3.6)。
 *
 * 空入力は deferred せず即時 ephemeral 通知(分類フローを開始しない)。入力ありは deferred を
 * 宣言し、分類と確認提示を {@link runClassification} で継続する。
 */
export const checkinModalSubmitHandler: InteractionHandler = {
  handle(ctx: InteractionContext, env: DiscordEnv): HandlerResult {
    const rawText = buildFieldLookup(ctx).get(CHECKIN_INPUT_FIELD_ID) ?? "";
    if (rawText.trim().length === 0) {
      return { mode: "reply", ephemeral: true, content: EMPTY_INPUT_NOTICE };
    }

    const userId = ctx.userId;
    return {
      mode: "deferred",
      ephemeral: true,
      run: (followup) => runClassification(env, userId, rawText, followup),
    };
  },
};
