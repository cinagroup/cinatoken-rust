import { describe, expect, test } from "vitest";

import {
  parseJsonCompatibilityInvokeCommandV1,
} from "../src/authorization";
import { validInvokeCommand } from "./fixtures";

describe("JSON compatibility invocation command protocol", () => {
  test("round-trips the exact command, subject, authority, and issue intent", async () => {
    const command = await validInvokeCommand();
    expect(parseJsonCompatibilityInvokeCommandV1(command)).toEqual(command);
  });

  test("rejects unknown fields and malformed nested command material", async () => {
    const command = await validInvokeCommand();
    expect(() => parseJsonCompatibilityInvokeCommandV1({
      ...command,
      publicUrl: "https://example.invalid",
    })).toThrow();
    expect(() => parseJsonCompatibilityInvokeCommandV1({
      ...command,
      subject: { ...command.subject, commandIdSha256: "not-a-digest" },
    })).toThrow();
    expect(() => parseJsonCompatibilityInvokeCommandV1({
      ...command,
      authority: { ...command.authority, algorithm: "none" },
    })).toThrow();
    expect(() => parseJsonCompatibilityInvokeCommandV1({
      ...command,
      authority: {
        ...command.authority,
        claims: { ...command.authority.claims, extra: true },
      },
    })).toThrow();
  });
});
