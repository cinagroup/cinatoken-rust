import { describe, expect, test } from "bun:test";
import {
  runBoundedSubprocess,
} from "../tools/lib/bounded_subprocess.mjs";

describe("bounded subprocess", () => {
  test("captures argument-array output without a shell", async () => {
    const result = await runBoundedSubprocess(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", "value;not-a-command"],
      { timeoutMs: 5_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("value;not-a-command");
    expect(result.terminationReason).toBeNull();
  });

  test("terminates a process tree when output exceeds the bound", async () => {
    const startedAt = Date.now();
    const result = await runBoundedSubprocess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)"],
      { maxOutputBytes: 64, timeoutMs: 5_000, killGraceMs: 500 },
    );
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.terminationReason).toBe("output-limit");
    expect(result.stdout).toBe("");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  test("terminates a process tree on timeout", async () => {
    const result = await runBoundedSubprocess(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { timeoutMs: 100, killGraceMs: 500 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.terminationReason).toBe("timeout");
    expect(result.stdout).toBe("");
  });

  test("rejects invalid UTF-8 output", async () => {
    const result = await runBoundedSubprocess(
      process.execPath,
      ["-e", "process.stdout.write(Buffer.from([255]))"],
      { timeoutMs: 5_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.invalidUtf8).toBe(true);
    expect(result.stdout).toBe("");
  });
});
