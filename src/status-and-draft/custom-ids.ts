/**
 * status-and-draft が所有する Discord custom_id 規約 (Req 5.5, 6.1-6.4, 7.1 /
 * design.md File Structure Plan `custom-ids.ts`、Boundary Commitments「custom_id 規約」、
 * handlers Implementation Notes「調整 kind と draftPendingId をボタン custom_id に埋め、
 * 抽出する」、Requirements Traceability 5.5)。
 *
 * 4 種の調整ボタン([短くする]=shorten /[成果を強める]=strengthen /
 * [課題を明確にする]=clarify /[上司向けにする]=manager)と[保存]ボタンは、揮発的な
 * draft pending を引くための draftPendingId を custom_id に埋め込む。調整ボタンは
 * draftPendingId に加えて調整 kind も埋め込み、parse 時に kind と draftPendingId の両方を
 * 復元できる。handlers/domain/registry には依存せず、純粋な組立・分解関数だけを提供する。
 *
 * 規約は checkin-classification の `custom-ids.ts` に倣う:
 * `prefix:encodeURIComponent(draftPendingId)` を基本形とし、空 draftPendingId は build で
 * 拒否、prefix 不一致・空 ID・不正形式は parse で null を返す。
 *
 * RefineKind 型は将来 draft スキーマ(draft/schema.ts)と共有されうるが、本 task では
 * draft/schema.ts が未作成のため custom-ids.ts 内に閉じた定義とする。
 */

/** ドラフト調整の種別。design.md の RefineKind と一致させる。 */
export type RefineKind = "shorten" | "strengthen" | "clarify" | "manager";

/** 調整種別の列挙(network/UI で 4 種を反復するための公開タプル)。 */
export const REFINE_KINDS = [
  "shorten",
  "strengthen",
  "clarify",
  "manager",
] as const satisfies readonly RefineKind[];

/** [短くする](shorten)調整ボタンの custom_id 接頭辞。 */
export const SHORTEN_BTN = "draft:refine:shorten";
/** [成果を強める](strengthen)調整ボタンの custom_id 接頭辞。 */
export const STRENGTHEN_BTN = "draft:refine:strengthen";
/** [課題を明確にする](clarify)調整ボタンの custom_id 接頭辞。 */
export const CLARIFY_BTN = "draft:refine:clarify";
/** [上司向けにする](manager)調整ボタンの custom_id 接頭辞。 */
export const MANAGER_BTN = "draft:refine:manager";
/** [保存]ボタンの custom_id 接頭辞。 */
export const SAVE_DRAFT_BTN = "draft:save";

const CUSTOM_ID_SEPARATOR = ":";

/** 調整 kind → ボタン接頭辞の対応。 */
const REFINE_KIND_TO_BASE: Record<RefineKind, string> = {
  shorten: SHORTEN_BTN,
  strengthen: STRENGTHEN_BTN,
  clarify: CLARIFY_BTN,
  manager: MANAGER_BTN,
};

/**
 * `prefix:encodeURIComponent(draftPendingId)` 形式の custom_id を組み立てる。
 * 空 draftPendingId は拒否する。
 */
function buildPendingId(base: string, draftPendingId: string): string {
  if (draftPendingId.length === 0) {
    throw new RangeError("draftPendingId must not be empty");
  }
  return `${base}${CUSTOM_ID_SEPARATOR}${encodeURIComponent(draftPendingId)}`;
}

/**
 * `prefix:encodeURIComponent(draftPendingId)` 形式の custom_id から draftPendingId を
 * 抽出する。prefix 不一致・空・不正形式は null。
 */
function parsePendingId(base: string, customId: string): string | null {
  const prefix = `${base}${CUSTOM_ID_SEPARATOR}`;
  if (!customId.startsWith(prefix)) return null;

  const encoded = customId.slice(prefix.length);
  if (encoded.length === 0) return null;

  try {
    const draftPendingId = decodeURIComponent(encoded);
    return draftPendingId.length > 0 ? draftPendingId : null;
  } catch {
    return null;
  }
}

/**
 * 調整ボタンの custom_id を kind + draftPendingId で組み立てる (Req 6.1-6.4)。
 *
 * kind は接頭辞に符号化される(parse 時に接頭辞から復元する)。空 draftPendingId は拒否。
 */
export function buildRefineButtonId(kind: RefineKind, draftPendingId: string): string {
  return buildPendingId(REFINE_KIND_TO_BASE[kind], draftPendingId);
}

/**
 * 調整ボタンの custom_id から kind と draftPendingId を抽出する (Req 6.1-6.4, 6.6)。
 *
 * 接頭辞が 4 種の調整ボタンのいずれかに一致し draftPendingId が復元できる場合に
 * `{ kind, draftPendingId }` を返す。それ以外(保存ボタン・未知 prefix・空・不正形式)は null。
 */
export function parseRefineButtonId(
  customId: string,
): { kind: RefineKind; draftPendingId: string } | null {
  for (const kind of REFINE_KINDS) {
    const draftPendingId = parsePendingId(REFINE_KIND_TO_BASE[kind], customId);
    if (draftPendingId !== null) {
      return { kind, draftPendingId };
    }
  }
  return null;
}

/**
 * [保存]ボタンの custom_id を draftPendingId 付きで組み立てる (Req 7.1)。空は拒否。
 */
export function buildSaveDraftButtonId(draftPendingId: string): string {
  return buildPendingId(SAVE_DRAFT_BTN, draftPendingId);
}

/**
 * [保存]ボタンの custom_id から draftPendingId を抽出する (Req 7.1, 7.4)。
 * 調整ボタン・未知 prefix・空・不正形式は null。
 */
export function parseSaveDraftButtonId(customId: string): string | null {
  return parsePendingId(SAVE_DRAFT_BTN, customId);
}
