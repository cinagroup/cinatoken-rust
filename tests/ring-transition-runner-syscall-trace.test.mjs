import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyConcurrentRingTransitionRunnerSyscallTraces,
  verifyRingTransitionRunnerSyscallTrace,
  verifyRingTransitionRunnerZeroNetworkTrace,
} from "../tools/verify_ring_transition_runner_syscall_trace.mjs";

const ROOT = "/tmp/cinatoken-ring-trace";
const RECEIPTS = `${ROOT}/execution-operation-receipts`;
const AUTHORIZATION = `${RECEIPTS}/${"a".repeat(64)}`;
const CLI = fileURLToPath(
  new URL("../tools/verify_ring_transition_runner_syscall_trace.mjs", import.meta.url),
);
const WORKFLOW = fileURLToPath(
  new URL("../.github/workflows/ring-transition-runner-linux.yml", import.meta.url),
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
        traceText: [
          fixtureTrace({ lockPairs: 2 }),
          "4000  socketpair(AF_UNIX, SOCK_SEQPACKET|SOCK_CLOEXEC, 0, [7, 8]) = 0",
        ].join("\n"),
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4100"],
      }),
    ).toMatchObject({
      ok: true,
      networkPolicy: "zero-network-syscalls-for-pinned-identities-v1",
      networkScope: "reported-verify-loaded-credentials-test-threads",
      expectedTracePidValues: ["4100"],
      networkSyscallsObserved: 0,
      networkSyscallNames: [],
      observedProcessIdentities: 2,
      unscopedNetworkSyscallsObserved: 1,
      unscopedNetworkSyscallNames: ["socketpair"],
      zeroNetworkSyscalls: true,
    });

    for (const syscall of [
      "socket(AF_INET, SOCK_STREAM|SOCK_CLOEXEC, IPPROTO_TCP) = -1 EACCES (Permission denied)",
      "connect(9, {sa_family=AF_INET, sin_port=htons(443)}, 16) = -1 ECONNREFUSED (Connection refused)",
      "recv(9, \"\", 1, 0) = -1 EBADF (Bad file descriptor)",
      "send(9, \"x\", 1, 0) = -1 EBADF (Bad file descriptor)",
      "sendto(9, \"x\", 1, 0, NULL, 0) = -1 EBADF (Bad file descriptor)",
    ]) {
      expect(() =>
        verifyRingTransitionRunnerZeroNetworkTrace({
          traceText: `${fixtureTrace({ lockPairs: 2 })}\n4100  ${syscall}`,
          label: "concurrent startup recovery",
          expectedTracePidValues: ["4100"],
        }),
      ).toThrow(/forbidden network syscall attempted/);
    }
    expect(() =>
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: `${fixtureTrace({ lockPairs: 2 })}\n4100  socket(AF_INET, <unfinished ...>`,
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4100"],
      }),
    ).toThrow(/incomplete or diagnostic/);
    expect(() =>
      verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: fixtureTrace({ lockPairs: 2 }),
        label: "concurrent startup recovery",
        expectedTracePidValues: ["4200"],
      }),
    ).toThrow(/expected trace PIDs were not all observed/);
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
        "--require-zero-network",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await zeroNetworkAccepted.exited).toBe(0);
    expect(
      JSON.parse(await new Response(zeroNetworkAccepted.stdout).text()),
    ).toMatchObject({
      ok: true,
      networkSyscallsObserved: 0,
      zeroNetworkSyscalls: true,
    });
    expect(await new Response(zeroNetworkAccepted.stderr).text()).toBe("");

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
    expect(workflow).toContain(
      "'.observedLockPidValues | sort'",
    );
    expect(workflow).toContain("concurrent-lock-thread-identity=verified");
    expect(workflow).toContain("processPid: $firstProcessPid");
    expect(workflow).toContain("lockThreadId: $firstLockThreadId");
    expect(workflow).toContain("exactlyOneRecoveryWriter");
    expect(workflow).toContain(
      "case \"${concurrent_first_unfinished}:${concurrent_second_unfinished}\" in",
    );
    expect(workflow).toContain(
      "transport::tests::linux_multiprocess_startup_terminal_candidate_converges_without_http",
    );
    expect(workflow).toContain(
      'startup_trace_filter="%file,%network,flock,fsync,fdatasync,fchmod,close,dup,dup2,dup3,fcntl"',
    );
    expect(workflow).toContain('-e "trace=${startup_trace_filter}"');
    expect(workflow).toContain("--require-zero-network");
    expect(workflow).toContain(
      '--expected-trace-pids "${startup_first_tid},${startup_second_tid}"',
    );
    expect(workflow).toContain("concurrent-startup-recovery-boundary.json");
    expect(workflow).toContain(
      'networkPolicy: "zero-network-syscalls-for-pinned-identities-v1"',
    );
    expect(workflow).toContain(
      'networkScope: "reported-verify-loaded-credentials-test-threads"',
    );
    expect(workflow).toContain("followForks: true");
    expect(workflow).toContain("traceSha256: $traceSha256");
    expect(workflow).toContain("preparedWithoutHttpCore: true");
    expect(workflow).toContain("networkSyscallsObserved: 0");
    expect(workflow).toContain("Retain successful syscall traces");
    expect(workflow).toContain("retention-days: 30");
  });
});

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
      `${pid}  flock(4<${RECEIPTS}>, LOCK_EX) = 0`,
      `${pid}  flock(5<${AUTHORIZATION}>, LOCK_EX) = 0`,
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
