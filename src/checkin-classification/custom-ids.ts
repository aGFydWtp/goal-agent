/**
 * checkin-classification が所有する Discord custom_id 規約 (Req 3.2, 3.7)。
 *
 * 保存・修正・破棄ボタンは、揮発的な pending 分類結果を引くための pendingId を
 * custom_id に埋め込む。handlers/domain/registry には依存せず、純粋な組立・分解関数だけを
 * 提供する。
 */

/** checkin 入力 modal の custom_id(modal submit ハンドラの照合キー)。 */
export const CHECKIN_MODAL_ID = "checkin:modal";

/**
 * checkin 入力 modal が内包する複数行 TextInput フィールドの custom_id。
 *
 * [入力する] ボタンが開く modal にこのフィールドを 1 つ載せ、modal submit ハンドラ(task 3.2)
 * がこの custom_id で raw テキストを読み取る。
 */
export const CHECKIN_INPUT_FIELD_ID = "checkin:input_field";

/** [入力する] ボタンの custom_id。pendingId は不要。 */
export const CHECKIN_INPUT_BUTTON_ID = "checkin:input";

/** [保存] ボタンの custom_id 接頭辞。実際の custom_id は pendingId を付けて生成する。 */
export const CHECKIN_SAVE_BUTTON_ID = "checkin:save";

/** [修正] ボタンの custom_id 接頭辞。実際の custom_id は pendingId を付けて生成する。 */
export const CHECKIN_EDIT_BUTTON_ID = "checkin:edit";

/** [破棄] ボタンの custom_id 接頭辞。実際の custom_id は pendingId を付けて生成する。 */
export const CHECKIN_DISCARD_BUTTON_ID = "checkin:discard";

const CUSTOM_ID_SEPARATOR = ":";

type PendingButtonBase =
  | typeof CHECKIN_SAVE_BUTTON_ID
  | typeof CHECKIN_EDIT_BUTTON_ID
  | typeof CHECKIN_DISCARD_BUTTON_ID;

function buildPendingButtonId(base: PendingButtonBase, pendingId: string): string {
  if (pendingId.length === 0) {
    throw new RangeError("pendingId must not be empty");
  }
  return `${base}${CUSTOM_ID_SEPARATOR}${encodeURIComponent(pendingId)}`;
}

function parsePendingButtonId(base: PendingButtonBase, customId: string): string | null {
  const prefix = `${base}${CUSTOM_ID_SEPARATOR}`;
  if (!customId.startsWith(prefix)) return null;

  const encodedPendingId = customId.slice(prefix.length);
  if (encodedPendingId.length === 0) return null;

  try {
    const pendingId = decodeURIComponent(encodedPendingId);
    return pendingId.length > 0 ? pendingId : null;
  } catch {
    return null;
  }
}

/** [保存] ボタンの custom_id を pendingId 付きで組み立てる。 */
export function buildCheckinSaveButtonId(pendingId: string): string {
  return buildPendingButtonId(CHECKIN_SAVE_BUTTON_ID, pendingId);
}

/** [保存] ボタンの custom_id から pendingId を抽出する。 */
export function parseCheckinSaveButtonId(customId: string): string | null {
  return parsePendingButtonId(CHECKIN_SAVE_BUTTON_ID, customId);
}

/** [修正] ボタンの custom_id を pendingId 付きで組み立てる。 */
export function buildCheckinEditButtonId(pendingId: string): string {
  return buildPendingButtonId(CHECKIN_EDIT_BUTTON_ID, pendingId);
}

/** [修正] ボタンの custom_id から pendingId を抽出する。 */
export function parseCheckinEditButtonId(customId: string): string | null {
  return parsePendingButtonId(CHECKIN_EDIT_BUTTON_ID, customId);
}

/** [破棄] ボタンの custom_id を pendingId 付きで組み立てる。 */
export function buildCheckinDiscardButtonId(pendingId: string): string {
  return buildPendingButtonId(CHECKIN_DISCARD_BUTTON_ID, pendingId);
}

/** [破棄] ボタンの custom_id から pendingId を抽出する。 */
export function parseCheckinDiscardButtonId(customId: string): string | null {
  return parsePendingButtonId(CHECKIN_DISCARD_BUTTON_ID, customId);
}
