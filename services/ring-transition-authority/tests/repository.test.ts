import { describe, expect, test } from "vitest";
import {
  RepositoryConflictError,
  createClaim,
  repositorySqlForTest,
} from "../src/repository";
import {
  CURRENT_CREDENTIAL,
  buildClaim,
  claimRow,
} from "./fixtures";

describe("D1 repository boundary", () => {
  test("uses only ordinary INSERT statements", () => {
    for (const sql of Object.values(repositorySqlForTest)) {
      expect(sql.trimStart().startsWith("INSERT INTO ")).toBe(true);
      expect(sql).not.toMatch(/\b(?:OR\s+IGNORE|REPLACE|UPSERT)\b/iu);
    }
  });

  test("uses first-primary and classifies a write exception by exact readback", async () => {
    const claim = await buildClaim();
    const row = claimRow(claim);
    const preparedSql: string[] = [];
    const session = {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          bind() {
            return {
              async run() {
                throw new Error("must not escape");
              },
              async first() {
                return row;
              },
            };
          },
        };
      },
    };
    let constraint = "";
    const database = {
      withSession(value: string) {
        constraint = value;
        return session;
      },
    } as unknown as D1Database;
    await expect(
      createClaim(database, claim, CURRENT_CREDENTIAL),
    ).resolves.toMatchObject({ classification: "exact_replay", claim: row });
    expect(constraint).toBe("first-primary");
    expect(preparedSql).toHaveLength(2);
  });

  test("returns a stable conflict when failed write has no exact match", async () => {
    const claim = await buildClaim();
    const session = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                throw new Error("sensitive SQL transport detail");
              },
              async first() {
                return null;
              },
            };
          },
        };
      },
    };
    const database = {
      withSession() {
        return session;
      },
    } as unknown as D1Database;
    await expect(
      createClaim(database, claim, CURRENT_CREDENTIAL),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
  });
});
