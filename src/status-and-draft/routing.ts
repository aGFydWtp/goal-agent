// status-and-draft の pending ドラフト routing ブリッジ(task 6.2 が消費)。
//
// なぜ必要か(KV ブリッジの根拠): `/draft`(生成)・4 種の調整ボタン・[保存] は別々の
// Discord interaction リクエストであり、ボタン custom_id には draftPendingId(+ kind)しか
// 乗らない。生成された揮発ドラフト(PendingDraft)はリクエストを跨いで保持する必要があり、
// その唯一の正しい置き場は実行ユーザーのデータホーム DO(`evaluation:{userId}:primary`)に
// 常駐する汎用揮発 KV である(infra-foundation task 4.5 の putEphemeral/getEphemeral/
// deleteEphemeral)。design.md の「Agent インスタンスメモリ」表現は ephemeral-KV 進化前の
// 記述であり、sibling spec checkin-classification(committed)の routing.ts が確立した
// ephemeral-KV 先例に倣う。task 5.3 の Map ベース PendingDraftStore はローカル作業 store で
// あり、本ブリッジは interaction ごとに KV から単一エントリの store を hydrate し、操作後に
// 再 persist する。
//
// 本モジュールは infra の汎用 KV(不透明文字列)を、domain/draft-operations.ts の同期
// `PendingDraftStore` と橋渡しする async ラッパに変換する。ドメインロジックは worker 側
// (domain)に留め、Agent へはドメインメソッドを追加しない(infra boundary / Req 8.3 適合)。
//
// 依存方向: handlers → routing → infra `getCycleAgent` / goal-management `PRIMARY_CYCLE_KEY` /
// 自スペック domain(左方向のみ)。

import { getCycleAgent } from "../agents/routing";
import type { DiscordEnv } from "../discord/env";
import { PRIMARY_CYCLE_KEY } from "../goal-management/routing";
import {
  createPendingDraftStore,
  type PendingDraft,
  type PendingDraftStore,
} from "./domain/draft-operations";

/** ephemeral KV 上で pending ドラフトを保持するキーの接頭辞。draftPendingId を付けて一意化する。 */
const PENDING_KEY_PREFIX = "draft:pending:";

/** draftPendingId から ephemeral KV キーを組み立てる。 */
export function pendingDraftKey(draftPendingId: string): string {
  return `${PENDING_KEY_PREFIX}${draftPendingId}`;
}

/**
 * EvaluationCycleAgent の汎用揮発 KV を async インターフェイスとして公開する。
 *
 * DO スタブの `putEphemeral`/`getEphemeral`/`deleteEphemeral` は RPC で Promise 化される。
 * 値は不透明文字列(pending ドラフトの JSON)で、本ラッパは中身を解釈しない。
 */
export interface DraftEphemeralKv {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

/**
 * 実行ユーザーのデータホーム DO(`evaluation:{userId}:primary`)の揮発 KV を取得する。
 *
 * 別ユーザーのボタン操作は別の論理 DO へ解決されるため、draftPendingId が一致しても他人の
 * pending は参照できない(所有者スコープを DO ルーティングで強制。domain 側でも userId 照合)。
 */
export async function getDraftEphemeralKv(
  env: DiscordEnv,
  userId: string,
): Promise<DraftEphemeralKv> {
  const stub = await getCycleAgent(env, userId, PRIMARY_CYCLE_KEY);
  return {
    put: (key, value) => stub.putEphemeral(key, value),
    get: (key) => stub.getEphemeral(key) as Promise<string | null>,
    delete: (key) => stub.deleteEphemeral(key),
  };
}

/** pending ドラフトを ephemeral KV へ不透明 JSON として保存する(生成/調整後)。 */
export async function persistPendingDraft(
  kv: DraftEphemeralKv,
  pending: PendingDraft,
): Promise<void> {
  await kv.put(pendingDraftKey(pending.draftPendingId), JSON.stringify(pending));
}

/**
 * ephemeral KV から pending ドラフトを読み、単一エントリの {@link PendingDraftStore} を組み立てる。
 *
 * 不在・JSON 破損・規約外の形は所有者照合不能として空 store を返す。domain の
 * `refineDraft`/`saveDraft` は空 store(または userId 不一致)に対して `not_found` を返すため、
 * ハンドラはそのまま操作不可へ正規化できる。
 */
export async function hydratePendingDraftStore(
  kv: DraftEphemeralKv,
  draftPendingId: string,
): Promise<PendingDraftStore> {
  const store = createPendingDraftStore();
  const raw = await kv.get(pendingDraftKey(draftPendingId));
  if (raw === null) {
    return store;
  }
  const pending = parsePendingDraft(raw);
  if (pending !== null) {
    store.drafts.set(pending.draftPendingId, pending);
  }
  return store;
}

/** 不透明 JSON 文字列を {@link PendingDraft} へ復元する(規約外は null)。 */
function parsePendingDraft(raw: string): PendingDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPendingDraft(value)) {
    return null;
  }
  return value;
}

/** パース結果が pending ドラフトの形を満たすかを最小限で検証する(KV は非永続・自スペック書込のみ)。 */
function isPendingDraft(value: unknown): value is PendingDraft {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.draftPendingId === "string" &&
    typeof candidate.userId === "string" &&
    typeof candidate.cycleId === "string" &&
    (candidate.goalId === null || typeof candidate.goalId === "string") &&
    typeof candidate.draftType === "string" &&
    typeof candidate.content === "object" &&
    candidate.content !== null &&
    typeof candidate.createdAt === "string"
  );
}
