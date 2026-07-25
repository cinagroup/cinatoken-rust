import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyRingTransitionRunnerSyscallTrace,
} from "../tools/verify_ring_transition_runner_syscall_trace.mjs";

const ROOT = "/tmp/cinatoken-ring-trace";
const RECEIPTS = `${ROOT}/execution-operation-receipts`;
const AUTHORIZATION = `${RECEIPTS}/${"a".repeat(64)}`;
const CLI = fileURLToPath(
  new URL("../tools/verify_ring_transition_runner_syscall_trace.mjs", import.meta.url),
);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ring-transition runner syscall trace verifier", () => {
  test("accepts exact paired locks and successful retained-dirfd evidence", () => {
    const result = verifyRingTransitionRunnerSyscallTrace({
      traceText: fixtureTrace({ lockPairs: 5, includeMkdirat: true }),
      fixtureRoot: ROOT,
      label: "full terminal transaction",
      expectedLocks: 10,
      requireMkdirat: true,
    });
    expect(result).toMatchObject({
      ok: true,
      observedLocks: 10,
      postLockUnconfinedMutation: false,
      successfulDirfdOpenat2: true,
      successfulDirfdRenameat2: true,
      successfulDirfdMkdirat: true,
      successfulDirectorySync: true,
      successfulDescriptorChmod: true,
    });
  });

  test("requires the complete two-lock protocol for every phase", () => {
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: fixtureTrace({ lockPairs: 2 }),
        fixtureRoot: ROOT,
        label: "focused recovery",
        expectedLocks: 2,
      }),
    ).toThrow(/expected exactly 2 .* found 4/);
  });

  test("rejects successful legacy mutation but permits failed EEXIST probes", () => {
    const safe = fixtureTrace({
      lockPairs: 2,
      extraAfterFirstLock:
        `4100  mkdir("${RECEIPTS}", 0700) = -1 EEXIST (File exists)`,
    });
    expect(
      verifyRingTransitionRunnerSyscallTrace({
        traceText: safe,
        fixtureRoot: ROOT,
        label: "focused recovery",
        expectedLocks: 4,
      }).ok,
    ).toBe(true);

    const unsafe = fixtureTrace({
      lockPairs: 2,
      extraAfterFirstLock:
        `4100  mkdir("${ROOT}/replacement", 0700) = 0`,
    });
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: unsafe,
        fixtureRoot: ROOT,
        label: "focused recovery",
        expectedLocks: 4,
      }),
    ).toThrow(/legacy pathname mutation/);
  });

  test("does not count failed syscalls as positive evidence", () => {
    const trace = fixtureTrace({ lockPairs: 2 }).replace(
      /renameat2\((.+)\) = 0/u,
      "renameat2($1) = -1 EACCES (Permission denied)",
    );
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: trace,
        fixtureRoot: ROOT,
        label: "focused recovery",
        expectedLocks: 4,
      }),
    ).toThrow(/successful_dirfd_renameat2/);
  });

  test("requires both locks while retained-dirfd mutation occurs", () => {
    const authorizationLock =
      `4100  flock(5<${AUTHORIZATION}>, LOCK_EX) = 0`;
    const trace = fixtureTrace({ lockPairs: 2 })
      .replace(`${authorizationLock}\n`, "")
      .replace(
        `4100  close(6<${AUTHORIZATION}/00000000000000000001.operation.json>) = 0`,
        `${authorizationLock}\n` +
          `4100  close(6<${AUTHORIZATION}/00000000000000000001.operation.json>) = 0`,
      );
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: trace,
        fixtureRoot: ROOT,
        label: "focused recovery",
        expectedLocks: 4,
      }),
    ).toThrow(/both locks/);
  });

  test("rejects AT_FDCWD and descriptors outside the fixture", () => {
    const atFdcwd = fixtureTrace({ lockPairs: 2 }).replace(
      `openat2(5<${AUTHORIZATION}>`,
      "openat2(AT_FDCWD",
    );
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: atFdcwd,
        fixtureRoot: ROOT,
        label: "focused recovery",
        expectedLocks: 4,
      }),
    ).toThrow(/AT_FDCWD/);

    const outside = fixtureTrace({ lockPairs: 2 }).replaceAll(
      AUTHORIZATION,
      "/tmp/outside",
    );
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: outside,
        fixtureRoot: ROOT,
        label: "focused recovery",
        expectedLocks: 4,
      }),
    ).toThrow(/fixture root|receipts\/authorization pair/);
  });

  test("rejects incomplete and unparsed trace lines", () => {
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: `${fixtureTrace({ lockPairs: 2 })}\n4100 openat2( <unfinished ...>`,
        fixtureRoot: ROOT,
        label: "focused recovery",
        expectedLocks: 4,
      }),
    ).toThrow(/incomplete or diagnostic/);
  });

  test("CLI verifies one bounded trace and rejects ambiguous invocation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cinatoken-trace-cli-"));
    temporaryDirectories.push(directory);
    const tracePath = path.join(directory, "trace.log");
    await writeFile(tracePath, fixtureTrace({ lockPairs: 2 }), "utf8");
    const accepted = Bun.spawn(
      [
        process.execPath,
        CLI,
        "--trace",
        tracePath,
        "--fixture-root",
        ROOT,
        "--label",
        "focused recovery",
        "--expected-locks",
        "4",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await accepted.exited).toBe(0);
    expect(JSON.parse(await new Response(accepted.stdout).text())).toMatchObject({
      ok: true,
      observedLocks: 4,
    });
    expect(await new Response(accepted.stderr).text()).toBe("");

    const rejected = Bun.spawn(
      [
        process.execPath,
        CLI,
        "--trace",
        tracePath,
        "--trace",
        tracePath,
        "--fixture-root",
        ROOT,
        "--label",
        "focused recovery",
        "--expected-locks",
        "4",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await rejected.exited).not.toBe(0);
    expect(await new Response(rejected.stdout).text()).toBe("");
  });
});

function fixtureTrace({
  lockPairs,
  includeMkdirat = false,
  extraAfterFirstLock = "",
}) {
  const lines = [
    `4100  open("${ROOT}", O_RDONLY|O_CLOEXEC|O_DIRECTORY|O_NOFOLLOW) = 3<${ROOT}>`,
  ];
  for (let pair = 0; pair < lockPairs; pair += 1) {
    lines.push(
      `4100  openat2(3<${ROOT}>, "execution-operation-receipts", {flags=O_RDONLY|O_CLOEXEC|O_DIRECTORY, resolve=RESOLVE_BENEATH}, 24) = 4<${RECEIPTS}>`,
      `4100  openat2(4<${RECEIPTS}>, "${"a".repeat(64)}", {flags=O_RDONLY|O_CLOEXEC|O_DIRECTORY, resolve=RESOLVE_BENEATH}, 24) = 5<${AUTHORIZATION}>`,
      `4100  flock(4<${RECEIPTS}>, LOCK_EX) = 0`,
      `4100  flock(5<${AUTHORIZATION}>, LOCK_EX) = 0`,
    );
    if (pair === 0 && extraAfterFirstLock) lines.push(extraAfterFirstLock);
    if (pair === 0) {
      if (includeMkdirat) {
        lines.push(
          `4100  mkdirat(5<${AUTHORIZATION}>, "execution-chain", 0700) = 0`,
        );
      }
      lines.push(
        `4100  openat2(5<${AUTHORIZATION}>, "00000000000000000001.operation.json.staging", {flags=O_RDWR|O_CLOEXEC|O_CREAT|O_EXCL, mode=0444, resolve=RESOLVE_BENEATH}, 24) = 6<${AUTHORIZATION}/00000000000000000001.operation.json.staging>`,
        `4100  fchmod(6<${AUTHORIZATION}/00000000000000000001.operation.json.staging>, 0444) = 0`,
        `4100  renameat2(5<${AUTHORIZATION}>, "00000000000000000001.operation.json.staging", 5<${AUTHORIZATION}>, "00000000000000000001.operation.json", RENAME_NOREPLACE) = 0`,
        `4100  fsync(5<${AUTHORIZATION}>) = 0`,
        `4100  close(6<${AUTHORIZATION}/00000000000000000001.operation.json>) = 0`,
      );
    }
    lines.push(
      `4100  close(5<${AUTHORIZATION}>) = 0`,
      `4100  close(4<${RECEIPTS}>) = 0`,
    );
  }
  lines.push(`4100  close(3<${ROOT}>) = 0`);
  return lines.join("\n");
}
