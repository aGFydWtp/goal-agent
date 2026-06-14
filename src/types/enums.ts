// 列挙値型(spec §11 / §10.1)。
// 各列挙値は readonly タプルとして単一定義し、union 型を派生させる。
// これによりランタイムの値リストとコンパイル時の型を単一の参照元から得る(Req 2.5, 5.1)。

/** goals.status の取り得る値(spec §10.1)。既定値は 'gray'。 */
export const GOAL_STATUSES = ["green", "yellow", "red", "gray"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** milestones.status の取り得る値(spec §11.3)。既定値は 'todo'。 */
export const MILESTONE_STATUSES = ["todo", "doing", "done", "dropped"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** evidence.source_type の取り得る値(spec §11.5)。 */
export const EVIDENCE_SOURCE_TYPES = [
  "manual_checkin",
  "discord_message",
  "github_pr",
  "meeting_note",
  "calendar_event",
  "other",
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

/** evidence.usefulness の取り得る値(spec §11.5)。既定値は 'medium'。 */
export const USEFULNESS_VALUES = ["low", "medium", "high"] as const;
export type Usefulness = (typeof USEFULNESS_VALUES)[number];

/** drafts.type の取り得る値(spec §11.8)。 */
export const DRAFT_TYPES = [
  "self_evaluation",
  "one_on_one",
  "manager_summary",
  "short_summary",
] as const;
export type DraftType = (typeof DRAFT_TYPES)[number];
