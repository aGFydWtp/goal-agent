// §11 データモデルの各エンティティに対応する行(row)型(Req 5.1, 5.2)。
// TEXT カラム → string、REAL → number、NOT NULL → 必須、NULL 許容 → `| null`。
// 行読み出し時の SQL NULL セマンティクスに合わせ、NULL 許容列は optional ではなく
// `field: T | null` で表現する(schema.ts(task 2.1)の列定義と一致させる)。

import type {
  DraftType,
  EvidenceSourceType,
  GoalStatus,
  MilestoneStatus,
  Usefulness,
} from "./enums";
import type { RelevanceScore } from "./llm-shared";

/** §11.1 evaluation_cycles */
export interface EvaluationCycleRow {
  id: string;
  user_id: string;
  name: string;
  start_date: string;
  end_date: string;
  created_at: string;
  updated_at: string;
}

/** §11.2 goals */
export interface GoalRow {
  id: string;
  cycle_id: string;
  user_id: string;
  title: string;
  description: string;
  success_criteria: string | null;
  evaluation_points: string | null;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
}

/** §11.3 milestones */
export interface MilestoneRow {
  id: string;
  goal_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  status: MilestoneStatus;
  created_at: string;
  updated_at: string;
}

/** §11.4 checkins */
export interface CheckinRow {
  id: string;
  cycle_id: string;
  user_id: string;
  raw_text: string;
  week_start_date: string;
  created_at: string;
}

/** §11.5 evidence */
export interface EvidenceRow {
  id: string;
  cycle_id: string;
  user_id: string;
  source_type: EvidenceSourceType;
  source_url: string | null;
  title: string | null;
  body: string;
  evidence_date: string;
  usefulness: Usefulness;
  created_at: string;
  updated_at: string;
}

/** §11.6 evidence_goal_links */
export interface EvidenceGoalLinkRow {
  id: string;
  evidence_id: string;
  goal_id: string;
  relevance_score: RelevanceScore;
  reason: string | null;
  created_at: string;
}

/** §11.7 weekly_reviews */
export interface WeeklyReviewRow {
  id: string;
  cycle_id: string;
  user_id: string;
  week_start_date: string;
  summary: string;
  risks: string | null;
  next_actions: string | null;
  created_at: string;
}

/** §11.8 drafts */
export interface DraftRow {
  id: string;
  cycle_id: string;
  goal_id: string | null;
  user_id: string;
  type: DraftType;
  body: string;
  created_at: string;
  updated_at: string;
}

/**
 * エンティティ名(= §11 のテーブル名)。Repository(task 2.3)が `EntityRow<E>` で
 * 行型を参照するための安定識別子。
 */
export type EntityName =
  | "evaluation_cycles"
  | "goals"
  | "milestones"
  | "checkins"
  | "evidence"
  | "evidence_goal_links"
  | "weekly_reviews"
  | "drafts";

/** エンティティ名 → 行型のマッピング。`EntityRow<'goals'>` のように使う。 */
export interface EntityRowMap {
  evaluation_cycles: EvaluationCycleRow;
  goals: GoalRow;
  milestones: MilestoneRow;
  checkins: CheckinRow;
  evidence: EvidenceRow;
  evidence_goal_links: EvidenceGoalLinkRow;
  weekly_reviews: WeeklyReviewRow;
  drafts: DraftRow;
}

/** 指定エンティティ名に対応する行型を解決する。 */
export type EntityRow<E extends EntityName> = EntityRowMap[E];
