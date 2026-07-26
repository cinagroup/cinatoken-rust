import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyConcurrentRingTransitionRunnerSyscallTraces,
  verifyRingTransitionRunnerSyscallTrace,
  verifyRingTransitionRunnerZeroNetworkTrace,
} from "../tools/verify_ring_transition_runner_syscall_trace.mjs";

const ROOT = "/tmp/cinatoken-ring-trace";
const TRACE_START = `${ROOT}.startup-trace-start`;
const TRACE_FINISH = `${ROOT}.startup-trace-finish`;
const RECEIPTS = `${ROOT}/execution-operation-receipts`;
const AUTHORIZATION = `${RECEIPTS}/${"a".repeat(64)}`;
const CLI = fileURLToPath(
  new URL(
    "../tools/verify_ring_transition_runner_syscall_trace.mjs",
    import.meta.url,
  ),
);
const WORKFLOW = fileURLToPath(
  new URL(
    "../.github/workflows/ring-transition-runner-linux.yml",
    import.meta.url,
  ),
);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
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
      lockPolicy: "exclusive-nonblocking-monotonic-deadline-v1",
      observedLocks: 10,
      observedSuccessfulLocks: 10,
      observedLockAttempts: 10,
      observedContentionRetries: 0,
      observedInterruptedRetries: 0,
      blockingLockAttemptsObserved: 0,
      postLockUnconfinedMutation: false,
      successfulDirfdOpenat2: true,
      successfulDirfdRenameat2: true,
      successfulDirfdMkdirat: true,
      successfulDirectorySync: true,
      successfulDescriptorChmod: true,
    });
  });

  test("accepts bounded nonblocking contention and EINTR retries", () => {
    const authorizationLock = `4100  flock(5<${AUTHORIZATION}>, LOCK_EX|LOCK_NB) = 0`;
    const trace = fixtureTrace({ lockPairs: 2 }).replace(
      authorizationLock,
      [
        `4100  flock(5<${AUTHORIZATION}>, LOCK_EX|LOCK_NB) = -1 EAGAIN (Resource temporarily unavailable)`,
        "4100  clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, {tv_sec=10, tv_nsec=20}, NULL) = -1 EINTR (Interrupted system call)",
        "4100  clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, {tv_sec=10, tv_nsec=20}, NULL) = 0",
        `4100  flock(5<${AUTHORIZATION}>, LOCK_NB|LOCK_EX) = -1 EWOULDBLOCK (Resource temporarily unavailable)`,
        "4100  clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, {tv_sec=10, tv_nsec=30}, NULL) = 0",
        `4100  flock(5<${AUTHORIZATION}>, LOCK_EX|LOCK_NB) = -1 EINTR (Interrupted system call)`,
        authorizationLock,
      ].join("\n"),
    );

    expect(
      verifyRingTransitionRunnerSyscallTrace({
        traceText: trace,
        fixtureRoot: ROOT,
        label: "contended recovery",
        expectedLocks: 4,
      }),
    ).toMatchObject({
      observedLocks: 4,
      observedSuccessfulLocks: 4,
      observedLockAttempts: 7,
      observedContentionRetries: 2,
      observedInterruptedRetries: 1,
      observedMonotonicSleeps: 2,
      observedInterruptedSleeps: 1,
      blockingLockAttemptsObserved: 0,
    });
  });

  test("rejects blocking flags, abnormal errno, drift, and missing sleep", () => {
    const base = fixtureTrace({ lockPairs: 2 });
    const authorizationLock = `4100  flock(5<${AUTHORIZATION}>, LOCK_EX|LOCK_NB) = 0`;
    const verify = (traceText) =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText,
        fixtureRoot: ROOT,
        label: "invalid lock trace",
        expectedLocks: 4,
      });

    expect(() => verify(base.replaceAll("LOCK_EX|LOCK_NB", "LOCK_EX"))).toThrow(
      /blocking or unexpected flock flags/,
    );
    expect(() =>
      verify(
        base.replace(
          authorizationLock,
          authorizationLock.replace(
            " = 0",
            " = -1 EBADF (Bad file descriptor)",
          ),
        ),
      ),
    ).toThrow(/failed unexpectedly/);
    expect(() =>
      verify(
        base.replace(
          authorizationLock,
          authorizationLock.replace(" = 0", " = 1"),
        ),
      ),
    ).toThrow(/failed unexpectedly/);
    expect(() =>
      verify(
        base.replace(
          authorizationLock,
          [
            authorizationLock.replace(
              " = 0",
              " = -1 EAGAIN (Resource temporarily unavailable)",
            ),
            authorizationLock,
          ].join("\n"),
        ),
      ),
    ).toThrow(/without a monotonic deadline sleep/);
    expect(() =>
      verify(
        base.replace(
          authorizationLock,
          [
            authorizationLock.replace(
              " = 0",
              " = -1 EINTR (Interrupted system call)",
            ),
            `4100  flock(6<${AUTHORIZATION}>, LOCK_EX|LOCK_NB) = 0`,
          ].join("\n"),
        ),
      ),
    ).toThrow(/lock retry identity drift/);
  });

  test("reconciles exact split flock calls and rejects unmatched resumes", () => {
    const authorizationLock = `4100  flock(5<${AUTHORIZATION}>, LOCK_EX|LOCK_NB) = 0`;
    const split = fixtureTrace({ lockPairs: 2 }).replace(
      authorizationLock,
      [
        `4100  flock(5<${AUTHORIZATION}>, LOCK_EX|LOCK_NB <unfinished ...>`,
        "4100  <... flock resumed>) = 0",
      ].join("\n"),
    );
    expect(
      verifyRingTransitionRunnerSyscallTrace({
        traceText: split,
        fixtureRoot: ROOT,
        label: "split lock trace",
        expectedLocks: 4,
      }),
    ).toMatchObject({
      observedSuccessfulLocks: 4,
      reconciledSplitTraceLines: 2,
    });
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: split.replace(
          "<... flock resumed>",
          "<... openat2 resumed>",
        ),
        fixtureRoot: ROOT,
        label: "split lock trace",
        expectedLocks: 4,
      }),
    ).toThrow(/no matching unfinished syscall/);
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

  test("requires the declared lock shape across concurrent recovery PIDs", () => {
    const trace = [
      fixtureTrace({ lockPairs: 3, pid: "4100", includeMkdirat: true }),
      fixtureTrace({ lockPairs: 3, pid: "4200" }),
    ].join("\n");
    expect(
      verifyRingTransitionRunnerSyscallTrace({
        traceText: trace,
        fixtureRoot: ROOT,
        label: "concurrent candidate recovery",
        expectedLocks: 12,
        expectedLockPids: 2,
        expectedLocksPerPid: 6,
        requireMkdirat: true,
      }),
    ).toMatchObject({
      ok: true,
      observedLocks: 12,
      observedLockPids: 2,
      observedLocksPerPid: [6, 6],
    });

    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: trace,
        fixtureRoot: ROOT,
        label: "concurrent candidate recovery",
        expectedLocks: 12,
        expectedLockPids: 1,
        expectedLocksPerPid: 12,
      }),
    ).toThrow(/expected 1 lock PIDs with 12 locks each/);

    const asymmetric = [
      fixtureTrace({ lockPairs: 2, pid: "4100" }),
      fixtureTrace({ lockPairs: 4, pid: "4200" }),
    ].join("\n");
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: asymmetric,
        fixtureRoot: ROOT,
        label: "concurrent candidate recovery",
        expectedLocks: 12,
        expectedLockPids: 2,
        expectedLocksPerPid: 6,
      }),
    ).toThrow(/found 2 PIDs with 4,8/);

    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: trace,
        fixtureRoot: ROOT,
        label: "concurrent candidate recovery",
        expectedLocks: 12,
        expectedLockPids: 2,
      }),
    ).toThrow(/must be supplied together/);
  });

  test("verifies two independent concurrent traces as one recovery bundle", () => {
    const second = fixtureTrace({
      lockPairs: 3,
      pid: "4200",
      includeMutation: false,
    });
    const firstSixLocks = fixtureTrace({
      lockPairs: 3,
      pid: "4100",
      includeMkdirat: true,
    });
    expect(
      verifyConcurrentRingTransitionRunnerSyscallTraces({
        traceTexts: [firstSixLocks, second],
        fixtureRoot: ROOT,
        label: "concurrent candidate recovery",
        expectedLocks: 12,
        expectedLockPids: 2,
        expectedLocksPerPid: 6,
        requireMkdirat: true,
      }),
    ).toMatchObject({
      ok: true,
      observedLocks: 12,
      observedLockPids: 2,
      observedLocksPerPid: [6, 6],
      observedLockPidValues: ["4100", "4200"],
      successfulDirfdMkdirat: true,
    });

    expect(() =>
      verifyConcurrentRingTransitionRunnerSyscallTraces({
        traceTexts: [
          firstSixLocks,
          fixtureTrace({ lockPairs: 3, pid: "4100" }),
        ],
        fixtureRoot: ROOT,
        label: "concurrent candidate recovery",
        expectedLocks: 12,
        expectedLockPids: 2,
        expectedLocksPerPid: 6,
      }),
    ).toThrow(/distinct lock PIDs/);

    expect(() =>
      verifyConcurrentRingTransitionRunnerSyscallTraces({
        traceTexts: [
          fixtureTrace({
            lockPairs: 3,
            pid: "4100",
            includeMutation: false,
          }),
          second,
        ],
        fixtureRoot: ROOT,
        label: "concurrent candidate recovery",
        expectedLocks: 12,
        expectedLockPids: 2,
        expectedLocksPerPid: 6,
      }),
    ).toThrow(/successful_dirfd_openat2/);
  });

  test("proves zero network syscalls and rejects even failed attempts", () => {
    expect(
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: startupWindowTrace({
          before: [
            "4000  socketpair(AF_UNIX, SOCK_SEQPACKET|SOCK_CLOEXEC, 0, [7, 8]) = 0",
          ],
          after: [
            '4000  readlink("/proc/self/exe",  <unfinished ...>',
            '4000  <... readlink resumed>"/tmp/runner", 4096) = 11',
          ],
        }),
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4100"],
        expectedTraceStartPaths: [TRACE_START],
        expectedTraceFinishPaths: [TRACE_FINISH],
      }),
    ).toMatchObject({
      ok: true,
      networkPolicy: "zero-network-syscalls-for-pinned-windows-v1",
      networkScope: "reported-verify-loaded-credentials-test-thread-windows",
      traceWindowPolicy: "successful-create-new-marker-open-v1",
      lockPolicy: "exclusive-nonblocking-monotonic-deadline-v1",
      expectedTracePidValues: ["4100"],
      networkSyscallsObserved: 0,
      networkSyscallNames: [],
      observedProcessIdentities: 2,
      unscopedIncompleteTraceLinesObserved: 2,
      unscopedNetworkSyscallsObserved: 1,
      unscopedNetworkSyscallNames: ["socketpair"],
      zeroNetworkSyscalls: true,
    });

    const startupAuthorizationLock = `4100  flock(5<${AUTHORIZATION}>, LOCK_EX|LOCK_NB) = 0`;
    const contendedStartup = startupWindowTrace().replace(
      startupAuthorizationLock,
      [
        startupAuthorizationLock.replace(
          " = 0",
          " = -1 EAGAIN (Resource temporarily unavailable)",
        ),
        "4100  clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, {tv_sec=10, tv_nsec=20}, NULL) = 0",
        startupAuthorizationLock,
      ].join("\n"),
    );
    expect(
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: contendedStartup,
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4100"],
        expectedTraceStartPaths: [TRACE_START],
        expectedTraceFinishPaths: [TRACE_FINISH],
      }),
    ).toMatchObject({
      observedSuccessfulLocks: 4,
      observedLockAttempts: 5,
      observedContentionRetries: 1,
      observedMonotonicSleeps: 1,
      blockingLockAttemptsObserved: 0,
    });
    expect(() =>
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: startupWindowTrace().replaceAll(
          "LOCK_EX|LOCK_NB",
          "LOCK_EX",
        ),
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4100"],
        expectedTraceStartPaths: [TRACE_START],
        expectedTraceFinishPaths: [TRACE_FINISH],
      }),
    ).toThrow(/blocking or unexpected flock flags/);

    for (const syscall of [
      "socket(AF_INET, SOCK_STREAM|SOCK_CLOEXEC, IPPROTO_TCP) = -1 EACCES (Permission denied)",
      "connect(9, {sa_family=AF_INET, sin_port=htons(443)}, 16) = -1 ECONNREFUSED (Connection refused)",
      'recv(9, "", 1, 0) = -1 EBADF (Bad file descriptor)',
      'send(9, "x", 1, 0) = -1 EBADF (Bad file descriptor)',
      'sendto(9, "x", 1, 0, NULL, 0) = -1 EBADF (Bad file descriptor)',
    ]) {
      expect(() =>
        verifyRingTransitionRunnerZeroNetworkTrace({
          traceText: startupWindowTrace({ inside: [`4100  ${syscall}`] }),
          label: "concurrent startup recovery",
          expectedTracePidValues: ["4100"],
          expectedTraceStartPaths: [TRACE_START],
          expectedTraceFinishPaths: [TRACE_FINISH],
        }),
      ).toThrow(/forbidden network syscall attempted/);
    }
    expect(() =>
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: startupWindowTrace({
          inside: ["4100  socket(AF_INET, <unfinished ...>"],
        }),
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4100"],
        expectedTraceStartPaths: [TRACE_START],
        expectedTraceFinishPaths: [TRACE_FINISH],
      }),
    ).toThrow(
      /forbidden network syscall attempted|unfinished syscalls were not resumed/,
    );
    expect(
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: startupWindowTrace({
          inside: [
            '4100  readlink("/proc/self/exe",  <unfinished ...>',
            '4100  <... readlink resumed>"/tmp/runner", 4096) = 11',
          ],
        }),
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4100"],
        expectedTraceStartPaths: [TRACE_START],
        expectedTraceFinishPaths: [TRACE_FINISH],
      }).zeroNetworkSyscalls,
    ).toBe(true);
    expect(() =>
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: startupWindowTrace({
          inside: ['4100  readlink("/proc/self/exe",  <unfinished ...>'],
        }),
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4100"],
        expectedTraceStartPaths: [TRACE_START],
        expectedTraceFinishPaths: [TRACE_FINISH],
      }),
    ).toThrow(/unfinished syscalls were not resumed/);
    expect(() =>
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: startupWindowTrace(),
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4200"],
        expectedTraceStartPaths: [TRACE_START],
        expectedTraceFinishPaths: [TRACE_FINISH],
      }),
    ).toThrow(/expected trace PIDs were not all observed/);
    expect(() =>
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: startupWindowTrace({
          after: [
            "4000  connect(9, {sa_family=AF_INET}, 16) = -1 ECONNREFUSED (Connection refused)",
          ],
        }),
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4100"],
        expectedTraceStartPaths: [TRACE_START],
        expectedTraceFinishPaths: [TRACE_FINISH],
      }),
    ).toThrow(/forbidden unscoped network syscall attempted/);
  });

  test("accepts only a scoped receipts-root lock timeout", () => {
    for (const retries of [1, 3]) {
      expect(
        verifyRingTransitionRunnerZeroNetworkTrace({
          traceText: startupLockTimeoutTrace({ retries }),
          fixtureRoot: ROOT,
          label: "startup receipts lock timeout",
          expectedTracePidValues: ["4100"],
          expectedTraceStartPaths: [TRACE_START],
          expectedTraceFinishPaths: [TRACE_FINISH],
          requireLockTimeout: true,
        }),
      ).toMatchObject({
        ok: true,
        lockPolicy: "exclusive-nonblocking-monotonic-deadline-v1",
        lockTimeoutPolicy: "typed-receipts-root-timeout-v1",
        lockTimeoutObserved: true,
        timedOutLockScope: "operation_receipts_lock",
        scopedLockAttempts: retries,
        scopedSuccessfulLocks: 0,
        scopedContentionRetries: retries,
        scopedMonotonicSleeps: retries,
        blockingLockAttemptsObserved: 0,
        networkSyscallsObserved: 0,
        zeroNetworkSyscalls: true,
      });
    }

    const verify = (traceText) =>
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText,
        fixtureRoot: ROOT,
        label: "startup receipts lock timeout",
        expectedTracePidValues: ["4100"],
        expectedTraceStartPaths: [TRACE_START],
        expectedTraceFinishPaths: [TRACE_FINISH],
        requireLockTimeout: true,
      });

    expect(() => verify(startupLockTimeoutTrace({ retries: 0 }))).toThrow(
      /lock timeout evidence is incomplete/,
    );
    expect(() =>
      verify(startupLockTimeoutTrace({ includeSuccessAfterContention: true })),
    ).toThrow(/lock timeout evidence is incomplete/);
    expect(() =>
      verify(startupLockTimeoutTrace({ pendingPath: `${ROOT}/other` })),
    ).toThrow(/lock timeout evidence is incomplete/);
    expect(() =>
      verify(startupLockTimeoutTrace({ retries: 2, sleepPid: "4200" })),
    ).toThrow(/retried without a monotonic deadline sleep/);
    expect(() =>
      verify(
        startupLockTimeoutTrace().replaceAll("LOCK_EX|LOCK_NB", "LOCK_EX"),
      ),
    ).toThrow(/blocking or unexpected flock flags/);
    expect(() =>
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: startupLockTimeoutTrace(),
        fixtureRoot: ROOT,
        label: "startup receipts lock timeout",
        expectedTracePidValues: ["4100", "4200"],
        expectedTraceStartPaths: [TRACE_START, `${TRACE_START}.peer`],
        expectedTraceFinishPaths: [TRACE_FINISH, `${TRACE_FINISH}.peer`],
        requireLockTimeout: true,
      }),
    ).toThrow(/lock-timeout trace arguments are invalid/);
  });

  test("rejects successful legacy mutation but permits failed EEXIST probes", () => {
    const safe = fixtureTrace({
      lockPairs: 2,
      extraAfterFirstLock: `4100  mkdir("${RECEIPTS}", 0700) = -1 EEXIST (File exists)`,
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
      extraAfterFirstLock: `4100  mkdir("${ROOT}/replacement", 0700) = 0`,
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

  test("binds terminal candidate sync to the locked process SIGKILL", () => {
    const trace = fixtureTrace({
      lockPairs: 2,
      includeTerminalCandidateSync: true,
      terminalSignal: "SIGKILL",
    });
    expect(
      verifyRingTransitionRunnerSyscallTrace({
        traceText: trace,
        fixtureRoot: ROOT,
        label: "candidate writer",
        expectedLocks: 4,
        requireSigkillExit: true,
        requireTerminalCandidateSync: true,
      }),
    ).toMatchObject({
      sigkillExitObserved: true,
      terminalCandidateRenameObserved: true,
      terminalCandidateReadbackObserved: true,
      terminalCandidateDirectorySyncObserved: true,
    });

    for (const termination of [
      "4100  +++ killed by SIGTERM +++",
      "4100  +++ exited with 0 +++",
    ]) {
      expect(() =>
        verifyRingTransitionRunnerSyscallTrace({
          traceText: trace.replace(
            "4100  +++ killed by SIGKILL +++",
            termination,
          ),
          fixtureRoot: ROOT,
          label: "candidate writer",
          expectedLocks: 4,
          requireSigkillExit: true,
          requireTerminalCandidateSync: true,
        }),
      ).toThrow(/SIGKILL exit/);
    }
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: trace.replace(
          /4100  openat2\(8<([^>]+)>, "terminal-snapshot-candidate\.json",/u,
          '4200  openat2(8<$1>, "terminal-snapshot-candidate.json",',
        ),
        fixtureRoot: ROOT,
        label: "candidate writer",
        expectedLocks: 4,
        requireSigkillExit: true,
        requireTerminalCandidateSync: true,
      }),
    ).toThrow(/readback moved to another process/);
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: trace.replace(
          `4100  fsync(8<${ROOT}/execution-operation-closures/${"a".repeat(64)}>) = 0\n` +
            `4100  openat2(8<${ROOT}/execution-operation-closures/${"a".repeat(64)}>, "terminal-snapshot-candidate.json",`,
          `4100  openat2(8<${ROOT}/execution-operation-closures/${"a".repeat(64)}>, "terminal-snapshot-candidate.json",`,
        ),
        fixtureRoot: ROOT,
        label: "candidate writer",
        expectedLocks: 4,
        requireSigkillExit: true,
        requireTerminalCandidateSync: true,
      }),
    ).toThrow(/rename\/directory-sync\/readback order/);
    expect(() =>
      verifyRingTransitionRunnerSyscallTrace({
        traceText: trace
          .replace("\n4100  +++ killed by SIGKILL +++", "")
          .replace(
            `4100  openat2(8<${ROOT}/execution-operation-closures/${"a".repeat(64)}>, "terminal-snapshot-candidate.json",`,
            `4100  +++ killed by SIGKILL +++\n` +
              `4100  openat2(8<${ROOT}/execution-operation-closures/${"a".repeat(64)}>, "terminal-snapshot-candidate.json",`,
          ),
        fixtureRoot: ROOT,
        label: "candidate writer",
        expectedLocks: 4,
        requireSigkillExit: true,
        requireTerminalCandidateSync: true,
      }),
    ).toThrow(/killed after durable readback/);
    expect(
      verifyRingTransitionRunnerSyscallTrace({
        traceText: fixtureTrace({ lockPairs: 2 }),
        fixtureRoot: ROOT,
        label: "legacy policy",
        expectedLocks: 4,
      }).ok,
    ).toBe(true);
  });

  test("requires both locks while retained-dirfd mutation occurs", () => {
    const authorizationLock = `4100  flock(5<${AUTHORIZATION}>, LOCK_EX|LOCK_NB) = 0`;
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
    ).toThrow(/incomplete or diagnostic|unfinished syscalls were not resumed/);
  });

  test("CLI verifies one bounded trace and rejects ambiguous invocation", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cinatoken-trace-cli-"),
    );
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
    expect(
      JSON.parse(await new Response(accepted.stdout).text()),
    ).toMatchObject({
      ok: true,
      lockPolicy: "exclusive-nonblocking-monotonic-deadline-v1",
      observedLocks: 4,
      observedSuccessfulLocks: 4,
      blockingLockAttemptsObserved: 0,
    });
    expect(await new Response(accepted.stderr).text()).toBe("");

    await writeFile(tracePath, startupWindowTrace(), "utf8");
    const zeroNetworkAccepted = Bun.spawn(
      [
        process.execPath,
        CLI,
        "--trace",
        tracePath,
        "--label",
        "concurrent startup recovery",
        "--expected-trace-pids",
        "4100",
        "--expected-trace-start-paths",
        TRACE_START,
        "--expected-trace-finish-paths",
        TRACE_FINISH,
        "--require-zero-network",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await zeroNetworkAccepted.exited).toBe(0);
    expect(
      JSON.parse(await new Response(zeroNetworkAccepted.stdout).text()),
    ).toMatchObject({
      ok: true,
      lockPolicy: "exclusive-nonblocking-monotonic-deadline-v1",
      networkSyscallsObserved: 0,
      blockingLockAttemptsObserved: 0,
      zeroNetworkSyscalls: true,
    });
    expect(await new Response(zeroNetworkAccepted.stderr).text()).toBe("");

    await writeFile(tracePath, startupLockTimeoutTrace({ retries: 2 }), "utf8");
    const lockTimeoutAccepted = Bun.spawn(
      [
        process.execPath,
        CLI,
        "--trace",
        tracePath,
        "--fixture-root",
        ROOT,
        "--label",
        "startup receipts lock timeout",
        "--expected-trace-pids",
        "4100",
        "--expected-trace-start-paths",
        TRACE_START,
        "--expected-trace-finish-paths",
        TRACE_FINISH,
        "--require-zero-network",
        "--require-lock-timeout",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await lockTimeoutAccepted.exited).toBe(0);
    expect(
      JSON.parse(await new Response(lockTimeoutAccepted.stdout).text()),
    ).toMatchObject({
      lockTimeoutPolicy: "typed-receipts-root-timeout-v1",
      lockTimeoutObserved: true,
      timedOutLockScope: "operation_receipts_lock",
      scopedSuccessfulLocks: 0,
      scopedContentionRetries: 2,
      scopedMonotonicSleeps: 2,
      networkSyscallsObserved: 0,
    });
    expect(await new Response(lockTimeoutAccepted.stderr).text()).toBe("");

    await writeFile(tracePath, startupWindowTrace(), "utf8");
    const zeroNetworkRejected = Bun.spawn(
      [
        process.execPath,
        CLI,
        "--trace",
        tracePath,
        "--fixture-root",
        ROOT,
        "--label",
        "concurrent startup recovery",
        "--expected-trace-pids",
        "4100",
        "--expected-trace-start-paths",
        TRACE_START,
        "--expected-trace-finish-paths",
        TRACE_FINISH,
        "--require-zero-network",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await zeroNetworkRejected.exited).not.toBe(0);
    expect(await new Response(zeroNetworkRejected.stderr).text()).toMatch(
      /zero-network trace arguments are invalid/,
    );

    const peerTracePath = path.join(directory, "peer-trace.log");
    await writeFile(
      tracePath,
      fixtureTrace({ lockPairs: 3, pid: "4100", includeMkdirat: true }),
      "utf8",
    );
    await writeFile(
      peerTracePath,
      fixtureTrace({
        lockPairs: 3,
        pid: "4200",
        includeMutation: false,
      }),
      "utf8",
    );
    const peerAccepted = Bun.spawn(
      [
        process.execPath,
        CLI,
        "--trace",
        tracePath,
        "--peer-trace",
        peerTracePath,
        "--fixture-root",
        ROOT,
        "--label",
        "concurrent recovery",
        "--expected-locks",
        "12",
        "--expected-lock-pids",
        "2",
        "--expected-locks-per-pid",
        "6",
        "--require-mkdirat",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await peerAccepted.exited).toBe(0);
    expect(
      JSON.parse(await new Response(peerAccepted.stdout).text()),
    ).toMatchObject({
      ok: true,
      observedLocks: 12,
      observedLockPids: 2,
      observedLocksPerPid: [6, 6],
    });
    expect(await new Response(peerAccepted.stderr).text()).toBe("");

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

  test("Linux workflow traces the candidate writer SIGKILL and fresh recovery separately", async () => {
    const workflow = await readFile(WORKFLOW, "utf8");
    expect(workflow).toContain(
      "CINATOKEN_RING_RECEIPT_TEST_ROLE=candidate-synced-wait",
    );
    expect(workflow).toContain("CINATOKEN_RING_RECEIPT_TEST_READY_STDOUT=1");
    expect(workflow).toContain('kill -KILL "${candidate_writer_pid}"');
    expect(workflow).toContain(
      "CINATOKEN_RING_RECEIPT_TEST_ROLE=recover-terminal-candidate",
    );
    expect(workflow).toMatch(
      /--label "candidate-after-sync writer"\s+\\\r?\n\s+--expected-locks 4\s+\\\r?\n\s+--require-mkdirat\s+\\\r?\n\s+--require-sigkill-exit\s+\\\r?\n\s+--require-terminal-candidate-sync/u,
    );
    expect(workflow).toMatch(
      /--label "candidate-after-sync recovery"\s+\\\r?\n\s+--expected-locks 8\s+\\\r?\n\s+--require-mkdirat/u,
    );
    expect(workflow).toContain("candidate-after-sync-writer.strace");
    expect(workflow).toContain("candidate-after-sync-recovery.strace");
    expect(workflow).toContain(
      '- "tools/verify_ring_transition_runner_syscall_trace.mjs"',
    );
    expect(workflow).toContain("Retain syscall verification summaries");
    expect(workflow).toContain(
      "CINATOKEN_RING_RECEIPT_TEST_ROLE=recover-terminal-candidate-concurrent-worker",
    );
    expect(workflow).toMatch(
      /--peer-trace "\$\{concurrent_second_trace_log\}"\s+\\\r?\n\s+--fixture-root "\$\{concurrent_trace_root\}"\s+\\\r?\n\s+--label "concurrent candidate recovery"\s+\\\r?\n\s+--expected-locks 12\s+\\\r?\n\s+--expected-lock-pids 2\s+\\\r?\n\s+--expected-locks-per-pid 6\s+\\\r?\n\s+--require-mkdirat/u,
    );
    expect(workflow).toContain("candidate-concurrent-recovery-boundary.json");
    expect(workflow).toContain("grep '^concurrent-lock-thread-id='");
    expect(workflow).toContain("'.observedLockPidValues | sort'");
    expect(workflow).toContain("concurrent-lock-thread-identity=verified");
    expect(workflow).toContain("processPid: $firstProcessPid");
    expect(workflow).toContain("lockThreadId: $firstLockThreadId");
    expect(workflow).toContain("exactlyOneRecoveryWriter");
    expect(workflow).toContain(
      'case "${concurrent_first_unfinished}:${concurrent_second_unfinished}" in',
    );
    expect(workflow).toContain(
      "transport::tests::linux_multiprocess_startup_terminal_candidate_converges_without_http",
    );
    expect(workflow).toContain(
      'startup_trace_filter="%file,%network,flock,clock_nanosleep,fsync,fdatasync,fchmod,close,dup,dup2,dup3,fcntl"',
    );
    expect(workflow).toContain('-e "trace=${startup_trace_filter}"');
    expect(workflow).toContain("--require-zero-network");
    expect(workflow).toContain(
      '--expected-trace-pids "${startup_first_tid},${startup_second_tid}"',
    );
    expect(workflow).toContain(
      '--expected-trace-start-paths "${startup_first_trace_start},${startup_second_trace_start}"',
    );
    expect(workflow).toContain(
      '--expected-trace-finish-paths "${startup_first_trace_finish},${startup_second_trace_finish}"',
    );
    expect(workflow).toContain("concurrent-startup-recovery-boundary.json");
    expect(workflow).toContain(
      'networkPolicy: "zero-network-syscalls-for-pinned-windows-v1"',
    );
    expect(workflow).toContain(
      'networkScope: "reported-verify-loaded-credentials-test-thread-windows"',
    );
    expect(workflow).toContain(
      'traceWindowPolicy: "successful-create-new-marker-open-v1"',
    );
    expect(workflow).toContain(
      'lockPolicy: "exclusive-nonblocking-monotonic-deadline-v1"',
    );
    expect(workflow).toContain("blockingLockAttemptsObserved: 0");
    expect(workflow).toContain(
      "exact successful paired nonblocking exclusive locks",
    );
    expect(workflow).toContain("one shared 5s CLOCK_MONOTONIC deadline");
    expect(workflow).toContain("followForks: true");
    expect(workflow).toContain("traceSha256: $traceSha256");
    expect(workflow).toContain("preparedWithoutHttpCore: true");
    expect(workflow).toContain("networkSyscallsObserved: 0");
    expect(workflow).toContain("(.unscopedNetworkSyscallsObserved == 3)");
    expect(workflow).toContain(
      '(.unscopedNetworkSyscallNames == ["socketpair"])',
    );
    expect(workflow).toContain(
      "unscopedIncompleteTraceLinesObserved: $unscopedIncompleteTraceLinesObserved",
    );
    expect(workflow).toContain("Retain successful syscall traces");
    expect(workflow).toContain("retention-days: 30");
  });

  test("Linux workflow freezes the typed startup receipts-lock timeout boundary", async () => {
    const workflow = await readFile(WORKFLOW, "utf8");
    expect(workflow).toContain(
      "transport::tests::linux_multiprocess_startup_lock_timeout_has_no_authority_side_effect",
    );
    expect(workflow).toMatch(
      /timeout --signal=TERM --kill-after=2s 15s\s+\\\r?\n\s+strace -f -qq -yy -s 4096/u,
    );
    expect(workflow).toContain(
      '--fixture-root "${startup_timeout_root}"',
    );
    expect(workflow).toContain("--require-lock-timeout");
    expect(workflow).toContain("startup-lock-timeout.verification.json");
    expect(workflow).toContain("startup-lock-timeout-boundary.json");
    expect(workflow).toContain(
      '(.lockTimeoutPolicy == "typed-receipts-root-timeout-v1")',
    );
    expect(workflow).toContain(
      '(.timedOutLockScope == "operation_receipts_lock")',
    );
    expect(workflow).toContain(
      "(.scopedContentionRetries == .scopedMonotonicSleeps)",
    );
    expect(workflow).toContain(
      'test "${startup_timeout_budget_ms}" = "5000"',
    );
    expect(workflow).toContain(
      'test "${startup_timeout_elapsed_ms}" -ge 4900',
    );
    expect(workflow).toContain(
      'test "${startup_timeout_elapsed_ms}" -lt 8000',
    );
    expect(workflow).toContain(
      'test "${startup_timeout_http_core_attempts}" = "0"',
    );
    expect(workflow).toContain(
      'test "${startup_timeout_fixture_unchanged}" = "true"',
    );
    expect(workflow).toContain(
      'test "${startup_timeout_recovery_action}" = "receipt-sealed"',
    );
    expect(workflow).toContain("httpExchangeConstructionAttempts: $httpExchangeConstructionAttempts");
    expect(workflow).toContain("fixtureTreeUnchanged: true");
    expect(workflow).toContain("traceSha256: $traceSha256");
    expect(workflow).toContain("traceBytes: $traceBytes");
    expect(workflow).toContain("startup-lock-timeout-boundary=verified");
  });

  test("Linux workflow runs a bounded startup schedule campaign without pinning retries", async () => {
    const workflow = await readFile(WORKFLOW, "utf8");
    expect(workflow).toContain("startup_soak_iterations=32");
    expect(workflow).toContain("startup_soak_iteration_watchdog_ms=15000");
    expect(workflow).toContain("startup_soak_campaign_budget_ms=120000");
    expect(workflow).toContain(
      'for iteration in $(seq 1 "${startup_soak_iterations}"); do',
    );
    expect(workflow).toContain(
      'timeout --signal=TERM --kill-after=2s \\',
    );
    expect(workflow).toContain(
      "transport::tests::linux_multiprocess_startup_terminal_candidate_converges_without_http",
    );
    expect(workflow).toContain("startup-schedule-soak-records.ndjson");
    expect(workflow).toContain("startup-schedule-soak-boundary.json");
    expect(workflow).toContain(
      'contract: "cinatoken-ring-transition-startup-schedule-soak-v1"',
    );
    expect(workflow).toContain(
      "allParticipantProcessPairsDistinct",
    );
    expect(workflow).toContain("allLockThreadPairsDistinct");
    expect(workflow).toContain("allActionsReceiptSealed");
    expect(workflow).toContain("grep '^startup-pair-action='");
    expect(workflow).toContain("uniqueClosureCount: ($closures | length)");
    expect(workflow).toContain(
      'policy: "single-captured-sample-plus-process-soak-v1"',
    );
    expect(workflow).toContain(
      ".observedIterations == .requiredIterations",
    );
    expect(workflow).toContain(
      ".campaignElapsedMs < .campaignBudgetMs",
    );
    expect(workflow).toContain("recordsSha256: $recordsSha256");
    expect(workflow).toContain(
      "(.samples | map(.iteration) | unique | length) ==",
    );
    expect(workflow).toContain(
      ".elapsedMs.max < .iterationWatchdogMs",
    );
    expect(workflow).toContain(
      "${{ runner.temp }}/ring-transition-syscall-traces/*.ndjson",
    );
    expect(workflow).toContain("startup-schedule-soak-boundary=verified");
    expect(workflow).not.toMatch(
      /startup[_-]soak[^\n]*(?:contention|retry)[^\n]*==\s*\d+/u,
    );
  });
});

function startupWindowTrace({
  pid = "4100",
  before = [],
  inside = [],
  after = [],
} = {}) {
  return [
    ...before,
    `${pid}  openat(AT_FDCWD, "${TRACE_START}", O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC, 0666) = 9<${TRACE_START}>`,
    fixtureTrace({ lockPairs: 2, pid }),
    ...inside,
    `${pid}  openat(AT_FDCWD, "${TRACE_FINISH}", O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC, 0666) = 10<${TRACE_FINISH}>`,
    ...after,
  ].join("\n");
}

function startupLockTimeoutTrace({
  pid = "4100",
  holderPid = "4000",
  retries = 1,
  pendingPath = RECEIPTS,
  sleepPid = pid,
  includeSuccessAfterContention = false,
} = {}) {
  const lines = [
    `${holderPid}  flock(7<${RECEIPTS}>, LOCK_EX|LOCK_NB) = 0`,
    `${pid}  openat(AT_FDCWD, "${TRACE_START}", O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC, 0666) = 9<${TRACE_START}>`,
  ];
  for (let retry = 0; retry < retries; retry += 1) {
    lines.push(
      `${pid}  flock(4<${pendingPath}>, LOCK_EX|LOCK_NB) = -1 EAGAIN (Resource temporarily unavailable)`,
      `${sleepPid}  clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, {tv_sec=10, tv_nsec=${20 + retry}}, NULL) = 0`,
    );
  }
  if (includeSuccessAfterContention) {
    lines.push(`${pid}  flock(4<${pendingPath}>, LOCK_EX|LOCK_NB) = 0`);
  }
  lines.push(
    `${pid}  openat(AT_FDCWD, "${TRACE_FINISH}", O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC, 0666) = 10<${TRACE_FINISH}>`,
    `${holderPid}  flock(7<${RECEIPTS}>, LOCK_UN) = 0`,
  );
  return lines.join("\n");
}

function fixtureTrace({
  lockPairs,
  pid = "4100",
  includeMutation = true,
  includeMkdirat = false,
  includeTerminalCandidateSync = false,
  terminalSignal = null,
  extraAfterFirstLock = "",
}) {
  const lines = [
    `${pid}  open("${ROOT}", O_RDONLY|O_CLOEXEC|O_DIRECTORY|O_NOFOLLOW) = 3<${ROOT}>`,
  ];
  for (let pair = 0; pair < lockPairs; pair += 1) {
    lines.push(
      `${pid}  openat2(3<${ROOT}>, "execution-operation-receipts", {flags=O_RDONLY|O_CLOEXEC|O_DIRECTORY, resolve=RESOLVE_BENEATH}, 24) = 4<${RECEIPTS}>`,
      `${pid}  openat2(4<${RECEIPTS}>, "${"a".repeat(64)}", {flags=O_RDONLY|O_CLOEXEC|O_DIRECTORY, resolve=RESOLVE_BENEATH}, 24) = 5<${AUTHORIZATION}>`,
      `${pid}  flock(4<${RECEIPTS}>, LOCK_EX|LOCK_NB) = 0`,
      `${pid}  flock(5<${AUTHORIZATION}>, LOCK_EX|LOCK_NB) = 0`,
    );
    if (pair === 0 && extraAfterFirstLock) lines.push(extraAfterFirstLock);
    if (pair === 0 && includeMutation) {
      if (includeMkdirat) {
        lines.push(
          `${pid}  mkdirat(5<${AUTHORIZATION}>, "execution-chain", 0700) = 0`,
        );
      }
      lines.push(
        `${pid}  openat2(5<${AUTHORIZATION}>, "00000000000000000001.operation.json.staging", {flags=O_RDWR|O_CLOEXEC|O_CREAT|O_EXCL, mode=0444, resolve=RESOLVE_BENEATH}, 24) = 6<${AUTHORIZATION}/00000000000000000001.operation.json.staging>`,
        `${pid}  fchmod(6<${AUTHORIZATION}/00000000000000000001.operation.json.staging>, 0444) = 0`,
        `${pid}  renameat2(5<${AUTHORIZATION}>, "00000000000000000001.operation.json.staging", 5<${AUTHORIZATION}>, "00000000000000000001.operation.json", RENAME_NOREPLACE) = 0`,
        `${pid}  fsync(5<${AUTHORIZATION}>) = 0`,
        `${pid}  close(6<${AUTHORIZATION}/00000000000000000001.operation.json>) = 0`,
      );
    }
    if (includeTerminalCandidateSync && pair === lockPairs - 1) {
      const closures = `${ROOT}/execution-operation-closures`;
      const closure = `${closures}/${"a".repeat(64)}`;
      lines.push(
        `${pid}  openat2(3<${ROOT}>, "execution-operation-closures", {flags=O_RDONLY|O_CLOEXEC|O_DIRECTORY, resolve=RESOLVE_BENEATH}, 24) = 7<${closures}>`,
        `${pid}  openat2(7<${closures}>, "${"a".repeat(64)}", {flags=O_RDONLY|O_CLOEXEC|O_DIRECTORY, resolve=RESOLVE_BENEATH}, 24) = 8<${closure}>`,
        `${pid}  openat2(8<${closure}>, "terminal-snapshot-candidate.json.staging", {flags=O_RDWR|O_CLOEXEC|O_CREAT|O_EXCL, mode=0444, resolve=RESOLVE_BENEATH}, 24) = 9<${closure}/terminal-snapshot-candidate.json.staging>`,
        `${pid}  fchmod(9<${closure}/terminal-snapshot-candidate.json.staging>, 0444) = 0`,
        `${pid}  renameat2(8<${closure}>, "terminal-snapshot-candidate.json.staging", 8<${closure}>, "terminal-snapshot-candidate.json", RENAME_NOREPLACE) = 0`,
        `${pid}  fsync(8<${closure}>) = 0`,
        `${pid}  openat2(8<${closure}>, "terminal-snapshot-candidate.json", {flags=O_RDONLY|O_CLOEXEC, resolve=RESOLVE_BENEATH}, 24) = 10<${closure}/terminal-snapshot-candidate.json>`,
        `${pid}  close(10<${closure}/terminal-snapshot-candidate.json>) = 0`,
        `${pid}  close(9<${closure}/terminal-snapshot-candidate.json>) = 0`,
        `${pid}  close(8<${closure}>) = 0`,
        `${pid}  close(7<${closures}>) = 0`,
      );
    }
    lines.push(
      `${pid}  close(5<${AUTHORIZATION}>) = 0`,
      `${pid}  close(4<${RECEIPTS}>) = 0`,
    );
  }
  lines.push(`${pid}  close(3<${ROOT}>) = 0`);
  if (terminalSignal) {
    lines.push(`${pid}  +++ killed by ${terminalSignal} +++`);
  }
  return lines.join("\n");
}
