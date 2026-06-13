import { describe, expect, it } from "vitest";
import {
  SCHEMA_STATEMENTS,
  SCHEMA_TABLE_NAMES,
} from "../src/persistence/schema";
import {
  GOAL_STATUSES,
  MILESTONE_STATUSES,
  USEFULNESS_VALUES,
} from "../src/types";

// §11 が定める 8 テーブル(親→子の依存安全順)。
const EXPECTED_TABLES = [
  "evaluation_cycles",
  "goals",
  "milestones",
  "checkins",
  "evidence",
  "evidence_goal_links",
  "weekly_reviews",
  "drafts",
] as const;

/** 指定テーブルの CREATE 文を取得する(テスト用ヘルパー)。 */
function statementFor(table: string): string {
  const stmt = SCHEMA_STATEMENTS.find((s) =>
    new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`).test(s),
  );
  if (!stmt) throw new Error(`no CREATE statement for table: ${table}`);
  return stmt;
}

describe("persistence schema: §11 DDL definitions", () => {
  it("exposes all 8 §11 table names in dependency-safe order", () => {
    expect(SCHEMA_TABLE_NAMES).toEqual(EXPECTED_TABLES);
  });

  it("provides one CREATE statement per table, in the same order", () => {
    expect(SCHEMA_STATEMENTS).toHaveLength(8);
    for (const [i, table] of EXPECTED_TABLES.entries()) {
      expect(SCHEMA_STATEMENTS[i]).toContain(
        `CREATE TABLE IF NOT EXISTS ${table}`,
      );
    }
  });

  it("uses IF NOT EXISTS for every statement (re-run safety)", () => {
    for (const stmt of SCHEMA_STATEMENTS) {
      expect(stmt).toContain("CREATE TABLE IF NOT EXISTS");
    }
  });

  it("does not define the schema_migrations ledger (owned by migrator)", () => {
    expect(SCHEMA_TABLE_NAMES).not.toContain("schema_migrations");
    for (const stmt of SCHEMA_STATEMENTS) {
      expect(stmt).not.toContain("schema_migrations");
    }
  });

  describe("required NOT NULL columns and enum defaults", () => {
    it("evaluation_cycles defines all §11.1 NOT NULL columns", () => {
      const ddl = statementFor("evaluation_cycles");
      expect(ddl).toContain("id TEXT PRIMARY KEY");
      for (const col of [
        "user_id",
        "name",
        "start_date",
        "end_date",
        "created_at",
        "updated_at",
      ]) {
        expect(ddl).toContain(`${col} TEXT NOT NULL`);
      }
    });

    it("goals defaults status to 'gray' (§11.2)", () => {
      const ddl = statementFor("goals");
      expect(ddl).toContain("status TEXT NOT NULL DEFAULT 'gray'");
      expect(ddl).toContain("description TEXT NOT NULL");
      // nullable columns must NOT be NOT NULL
      expect(ddl).toContain("success_criteria TEXT");
      expect(ddl).toContain("evaluation_points TEXT");
      expect(ddl).not.toContain("success_criteria TEXT NOT NULL");
    });

    it("milestones defaults status to 'todo' (§11.3)", () => {
      const ddl = statementFor("milestones");
      expect(ddl).toContain("status TEXT NOT NULL DEFAULT 'todo'");
      expect(ddl).toContain("goal_id TEXT NOT NULL");
    });

    it("checkins defines §11.4 NOT NULL columns", () => {
      const ddl = statementFor("checkins");
      for (const col of [
        "cycle_id",
        "user_id",
        "raw_text",
        "week_start_date",
        "created_at",
      ]) {
        expect(ddl).toContain(`${col} TEXT NOT NULL`);
      }
    });

    it("evidence defaults usefulness to 'medium' (§11.5)", () => {
      const ddl = statementFor("evidence");
      expect(ddl).toContain("usefulness TEXT NOT NULL DEFAULT 'medium'");
      expect(ddl).toContain("source_type TEXT NOT NULL");
      expect(ddl).toContain("body TEXT NOT NULL");
      expect(ddl).toContain("evidence_date TEXT NOT NULL");
    });

    it("evidence_goal_links uses REAL for relevance_score (§11.6)", () => {
      const ddl = statementFor("evidence_goal_links");
      expect(ddl).toContain("relevance_score REAL NOT NULL");
      expect(ddl).toContain("evidence_id TEXT NOT NULL");
      expect(ddl).toContain("goal_id TEXT NOT NULL");
    });

    it("weekly_reviews defines §11.7 NOT NULL columns", () => {
      const ddl = statementFor("weekly_reviews");
      for (const col of ["cycle_id", "user_id", "week_start_date", "summary"]) {
        expect(ddl).toContain(`${col} TEXT NOT NULL`);
      }
    });

    it("drafts allows NULL goal_id and requires type/body (§11.8)", () => {
      const ddl = statementFor("drafts");
      expect(ddl).toContain("type TEXT NOT NULL");
      expect(ddl).toContain("body TEXT NOT NULL");
      expect(ddl).toContain("goal_id TEXT");
      expect(ddl).not.toContain("goal_id TEXT NOT NULL");
    });
  });

  describe("enum-default alignment with shared types (Req 2.5)", () => {
    it("'gray' default is a member of GOAL_STATUSES", () => {
      expect(GOAL_STATUSES).toContain("gray");
      expect(statementFor("goals")).toContain("DEFAULT 'gray'");
    });

    it("'todo' default is a member of MILESTONE_STATUSES", () => {
      expect(MILESTONE_STATUSES).toContain("todo");
      expect(statementFor("milestones")).toContain("DEFAULT 'todo'");
    });

    it("'medium' default is a member of USEFULNESS_VALUES", () => {
      expect(USEFULNESS_VALUES).toContain("medium");
      expect(statementFor("evidence")).toContain("DEFAULT 'medium'");
    });
  });
});
