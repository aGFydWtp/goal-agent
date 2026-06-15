import type { GoalStatus } from "../../types/enums";

/**
 * §10.2 ルール前処理の入力となる、所有者スコープ済みの目標コンテキスト(Req 1.1)。
 *
 * 上流の `collectGoalContext` が目標定義(達成条件・評価観点)・紐づく証跡・
 * 半期終了までの日数・最新証跡経過を集約して構成する。
 */
export interface GoalStatusContext {
  goalId: string;
  title: string;
  description: string;
  /** 達成条件。未設定は null(判断材料不足の根拠になる)。 */
  successCriteria: string | null;
  evaluationPoints: string | null;
  evidence: ReadonlyArray<{ body: string; evidenceDate: string; usefulness: string }>;
  /** 半期終了までの日数。小さいほど期限が近い。 */
  daysUntilCycleEnd: number;
  /** 最新証跡からの経過日数。証跡なしは null。 */
  latestEvidenceAgeDays: number | null;
}

/**
 * §10.2 ルール前処理の出力。LLM 見立てと統合(`combineVerdict`)される候補状態(Req 1.2)。
 */
export interface RuleOutcome {
  /** ルールが導いた候補状態(green | yellow | red | gray)。 */
  candidate: GoalStatus;
  /** Gray 根拠: 証跡少/達成条件未設定/定義曖昧で判断材料が不足(Req 1.4, 3.5)。 */
  insufficientMaterial: boolean;
}

/** 直近証跡とみなす上限(2週間=14日以内)。これ以内なら活動継続中(§10.2)。 */
const RECENT_EVIDENCE_MAX_AGE_DAYS = 14;
/** 証跡なしとみなす下限(3週間=21日以上証跡なし)。これ以上で Red 寄り(§10.2)。 */
const STALE_EVIDENCE_MIN_AGE_DAYS = 21;
/** 判断材料として最低限必要な証跡件数。これ未満は Gray 寄り(Req 1.4, 3.5)。 */
const MIN_EVIDENCE_COUNT = 2;
/** 目標定義が曖昧でないとみなす説明文の最低文字数。これ未満は判断材料不足。 */
const MIN_DESCRIPTION_LENGTH = 10;
/** 半期終了が「近い」とみなす残日数の上限。これ以下かつ証跡停滞は警告寄り(§10.2)。 */
const CYCLE_END_NEAR_DAYS = 7;

/** 値が未設定・空白のみでない実効テキストを持つか。 */
function hasMeaningfulText(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

/**
 * §10.2 ルール前処理: 目標コンテキストから Green/Yellow/Red/Gray の候補状態を導く。
 *
 * 評価順序(先に該当したものを優先):
 * 1. 判断材料不足(達成条件未設定/定義曖昧/証跡少・ゼロ)→ Gray(insufficientMaterial)(Req 1.4, 3.5)。
 * 2. 3週間以上証跡なし → Red 候補(§10.2)。
 * 3. 直近2週内に証跡あり、かつ調査偏重(全て low usefulness)→ Yellow 候補(着手はあるが進捗不足)。
 * 4. 直近2週内に証跡あり → Green 候補(§10.2)。
 * 5. 2週超3週未満(停滞気味)→ Yellow 候補。半期終了が近ければさらに警告寄り(§10.2)。
 *
 * @returns 候補状態と判断材料不足フラグ。LLM 失敗時はこの候補で status を成立させる(Req 1.5)。
 */
export function evaluateRules(ctx: GoalStatusContext): RuleOutcome {
  // ルール: 定義/証跡の不足は判断材料不足として Gray を最優先(Req 1.4, 3.5)。
  // 証跡ゼロ・達成条件未設定・目標定義が曖昧・証跡が少なすぎる、のいずれかで成立。
  const noEvidence = ctx.evidence.length === 0 || ctx.latestEvidenceAgeDays === null;
  const successCriteriaMissing = !hasMeaningfulText(ctx.successCriteria);
  const definitionAmbiguous = ctx.description.trim().length < MIN_DESCRIPTION_LENGTH;
  const tooFewEvidence = ctx.evidence.length < MIN_EVIDENCE_COUNT;

  if (noEvidence || successCriteriaMissing || definitionAmbiguous || tooFewEvidence) {
    return { candidate: "gray", insufficientMaterial: true };
  }

  // ここに到達した時点で証跡が存在するため latestEvidenceAgeDays は非 null。
  const latestAge = ctx.latestEvidenceAgeDays ?? Number.POSITIVE_INFINITY;

  // ルール: 3週間以上証跡なし → Red 候補(§10.2)。
  if (latestAge >= STALE_EVIDENCE_MIN_AGE_DAYS) {
    return { candidate: "red", insufficientMaterial: false };
  }

  // ルール: 直近2週内に証跡あり(§10.2)。
  if (latestAge <= RECENT_EVIDENCE_MAX_AGE_DAYS) {
    // ルール: 達成条件への着手はあるが調査偏重(全て low usefulness)で十分な進捗がない
    // → Yellow 候補(design Testing Strategy「調査偏重で Yellow 候補」)。
    const investigationHeavy = ctx.evidence.every((item) => item.usefulness === "low");
    if (investigationHeavy) {
      return { candidate: "yellow", insufficientMaterial: false };
    }

    // 直近活動があり成果証跡も伴う → Green 候補(§10.2)。
    return { candidate: "green", insufficientMaterial: false };
  }

  // ルール: 2週超3週未満は停滞気味。半期終了の近さで警告度合いを上げる(§10.2: 半期終了の近さ)。
  // 残日数が閾値以下なら回復余地が乏しく証跡停滞が深刻なため Red 寄りに、
  // まだ余裕があれば警告の Yellow に寄せる。
  if (ctx.daysUntilCycleEnd <= CYCLE_END_NEAR_DAYS) {
    return { candidate: "red", insufficientMaterial: false };
  }
  return { candidate: "yellow", insufficientMaterial: false };
}
