#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TRACE_BYTES = 32 * 1024 * 1024;
const WRITE_FLAGS = Object.freeze([
  "O_WRONLY",
  "O_RDWR",
  "O_CREAT",
  "O_TRUNC",
  "O_APPEND",
]);
const LEGACY_PATH_MUTATIONS = new Set([
  "chown",
  "chmod",
  "chroot",
  "creat",
  "lchown",
  "link",
  "lremovexattr",
  "lsetxattr",
  "mkdir",
  "mknod",
  "mount",
  "open",
  "removexattr",
  "rename",
  "rmdir",
  "setxattr",
  "symlink",
  "truncate",
  "unlink",
  "umount",
  "umount2",
  "utime",
  "utimes",
]);
const ALLOWED_DIRFD_MUTATIONS = new Set([
  "fchmodat",
  "mkdirat",
  "openat2",
  "renameat2",
  "unlinkat",
]);
const NETWORK_SYSCALLS = new Set([
  "accept",
  "accept4",
  "bind",
  "connect",
  "getpeername",
  "getsockname",
  "getsockopt",
  "listen",
  "recv",
  "recvfrom",
  "recvmmsg",
  "recvmsg",
  "send",
  "sendmmsg",
  "sendmsg",
  "sendto",
  "setsockopt",
  "shutdown",
  "socket",
  "socketcall",
  "socketpair",
]);
const ALLOWED_UNSCOPED_NETWORK_SYSCALLS = new Set(["socketpair"]);

export function verifyRingTransitionRunnerSyscallTrace({
  traceText,
  fixtureRoot,
  label,
  expectedLocks,
  expectedLockPids = null,
  expectedLocksPerPid = null,
  requireMkdirat = false,
  requireMutationEvidence = true,
  requireSigkillExit = false,
  requireTerminalCandidateSync = false,
}) {
  const root = normalizeFixtureRoot(fixtureRoot);
  if (typeof label !== "string" || label.length < 1 || label.length > 80) {
    throw new Error("[input] trace label is invalid");
  }
  if (
    !Number.isSafeInteger(expectedLocks) ||
    expectedLocks < 2 ||
    expectedLocks > 128 ||
    expectedLocks % 2 !== 0
  ) {
    throw new Error("[input] expected locks must be a positive pair count");
  }
  if ((expectedLockPids === null) !== (expectedLocksPerPid === null)) {
    throw new Error(
      "[input] expected lock PIDs and locks per PID must be supplied together",
    );
  }
  if (
    expectedLockPids !== null &&
    (
      !Number.isSafeInteger(expectedLockPids) ||
      expectedLockPids < 1 ||
      expectedLockPids > 64 ||
      !Number.isSafeInteger(expectedLocksPerPid) ||
      expectedLocksPerPid < 2 ||
      expectedLocksPerPid > 128 ||
      expectedLocksPerPid % 2 !== 0 ||
      expectedLockPids * expectedLocksPerPid !== expectedLocks
    )
  ) {
    throw new Error("[input] expected per-PID lock shape is invalid");
  }
  if (
    typeof traceText !== "string" ||
    traceText.length < 1 ||
    Buffer.byteLength(traceText, "utf8") > MAX_TRACE_BYTES
  ) {
    throw new Error(`[${label}] trace size is invalid`);
  }

  const descriptorState = new Map();
  const heldLocks = new Map();
  const exclusiveLocks = [];
  const evidence = {
    dirfdOpenat2: false,
    dirfdRenameat2: false,
    dirfdMkdirat: false,
    directorySync: false,
    descriptorChmod: false,
    terminalCandidatePid: null,
    terminalCandidateRenameAt: null,
    terminalCandidateReadbackAt: null,
    terminalCandidateDirectorySyncAt: null,
  };
  const processTerminations = [];
  let firstExclusiveLock = null;
  let parsedSyscalls = 0;

  for (const [index, rawLine] of traceText.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (
      line.includes("<unfinished ...>") ||
      line.includes("resumed>") ||
      line.startsWith("strace:")
    ) {
      throw new Error(`[${label}] incomplete or diagnostic trace line: ${line}`);
    }
    const termination = parseProcessTerminationLine(line);
    if (termination) {
      processTerminations.push({ ...termination, index });
      continue;
    }
    if (
      /^(?:(?:\d+\s+)|(?:\[pid\s+\d+\]\s+))?(?:--- |\+\+\+ |Process )/u.test(
        line,
      )
    ) {
      continue;
    }
    const syscall = parseSyscallLine(line);
    if (!syscall) {
      throw new Error(`[${label}] unparsed trace line: ${line}`);
    }
    parsedSyscalls += 1;

    rememberDescriptor(syscall, descriptorState);
    const success = resultIsSuccess(syscall.result);
    const afterFirstLock =
      firstExclusiveLock !== null && index >= firstExclusiveLock;

    if (
      syscall.name === "flock" &&
      syscall.args.includes("LOCK_EX") &&
      success
    ) {
      const descriptor = descriptorArgument(
        syscall.args,
        syscall.pid,
        descriptorState,
      );
      requireFixtureDescriptor(descriptor, root, label, "exclusive flock");
      locksFor(heldLocks, syscall.pid).set(descriptor.fd, descriptor.path);
      exclusiveLocks.push({
        pid: syscall.pid,
        fd: descriptor.fd,
        path: descriptor.path,
      });
      if (firstExclusiveLock === null) firstExclusiveLock = index;
      continue;
    }
    if (
      syscall.name === "flock" &&
      syscall.args.includes("LOCK_UN") &&
      success
    ) {
      const descriptor = parseDescriptorToken(syscall.args);
      if (descriptor) locksFor(heldLocks, syscall.pid).delete(descriptor.fd);
      continue;
    }

    if (afterFirstLock && success) {
      verifySuccessfulMutation({
        syscall,
        root,
        label,
        descriptorState,
        heldLocks,
        evidence,
      });
      observeTerminalCandidateEvidence({
        syscall,
        index,
        root,
        label,
        descriptorState,
        evidence,
      });
    }

    if (syscall.name === "close" && success) {
      const descriptor = parseDescriptorToken(syscall.args);
      if (descriptor) {
        descriptorState.delete(descriptorKey(syscall.pid, descriptor.fd));
        locksFor(heldLocks, syscall.pid).delete(descriptor.fd);
      }
    }
  }

  if (parsedSyscalls === 0 || firstExclusiveLock === null) {
    throw new Error(`[${label}] trace contains no parsed locked syscall`);
  }
  verifyExclusiveLockPairs(exclusiveLocks, root, label, expectedLocks);
  const locksByPid = new Map();
  for (const lock of exclusiveLocks) {
    locksByPid.set(lock.pid, (locksByPid.get(lock.pid) ?? 0) + 1);
  }
  const observedLocksPerPid = [...locksByPid.values()].sort(
    (left, right) => left - right,
  );
  if (
    expectedLockPids !== null &&
    (
      locksByPid.size !== expectedLockPids ||
      observedLocksPerPid.some((count) => count !== expectedLocksPerPid)
    )
  ) {
    throw new Error(
      `[${label}] expected ${expectedLockPids} lock PIDs with ${expectedLocksPerPid} locks each, found ${locksByPid.size} PIDs with ${observedLocksPerPid.join(",")}`,
    );
  }
  const missing = [];
  if (requireMutationEvidence && !evidence.dirfdOpenat2) {
    missing.push("successful_dirfd_openat2");
  }
  if (requireMutationEvidence && !evidence.dirfdRenameat2) {
    missing.push("successful_dirfd_renameat2");
  }
  if (requireMutationEvidence && !evidence.directorySync) {
    missing.push("successful_directory_sync");
  }
  if (requireMutationEvidence && !evidence.descriptorChmod) {
    missing.push("successful_descriptor_chmod");
  }
  if (requireMkdirat && !evidence.dirfdMkdirat) {
    missing.push("successful_dirfd_mkdirat");
  }
  if (missing.length > 0) {
    throw new Error(`[${label}] trace missing required evidence: ${missing.join(", ")}`);
  }
  const lockPids = new Set(exclusiveLocks.map((lock) => lock.pid));
  const matchingSigkills = processTerminations.filter(
    (termination) =>
      termination.signal === "SIGKILL" && lockPids.has(termination.pid),
  );
  if (requireSigkillExit && matchingSigkills.length !== 1) {
    throw new Error(
      `[${label}] expected exactly one locked process SIGKILL exit, found ${matchingSigkills.length}`,
    );
  }
  if (requireTerminalCandidateSync) {
    const ordered =
      evidence.terminalCandidateRenameAt !== null &&
      evidence.terminalCandidateReadbackAt !== null &&
      evidence.terminalCandidateDirectorySyncAt !== null &&
      evidence.terminalCandidateRenameAt <
        evidence.terminalCandidateDirectorySyncAt &&
      evidence.terminalCandidateDirectorySyncAt <
        evidence.terminalCandidateReadbackAt;
    if (!ordered) {
      throw new Error(
        `[${label}] terminal candidate rename/directory-sync/readback order is missing`,
      );
    }
    if (
      requireSigkillExit &&
      (
        matchingSigkills[0].pid !== evidence.terminalCandidatePid ||
        matchingSigkills[0].index <= evidence.terminalCandidateReadbackAt
      )
    ) {
      throw new Error(
        `[${label}] terminal candidate writer PID was not killed after durable readback completed`,
      );
    }
  }

  return {
    ok: true,
    label,
    expectedLocks,
    observedLocks: exclusiveLocks.length,
    observedLockPids: locksByPid.size,
    observedLocksPerPid,
    observedLockPidValues: [...locksByPid.keys()].sort(),
    postLockUnconfinedMutation: false,
    successfulDirfdOpenat2: evidence.dirfdOpenat2,
    successfulDirfdRenameat2: evidence.dirfdRenameat2,
    successfulDirfdMkdirat: evidence.dirfdMkdirat,
    successfulDirectorySync: evidence.directorySync,
    successfulDescriptorChmod: evidence.descriptorChmod,
    sigkillExitObserved: matchingSigkills.length === 1,
    terminalCandidateRenameObserved:
      evidence.terminalCandidateRenameAt !== null,
    terminalCandidateReadbackObserved:
      evidence.terminalCandidateReadbackAt !== null,
    terminalCandidateDirectorySyncObserved:
      evidence.terminalCandidateDirectorySyncAt !== null,
  };
}

export function verifyConcurrentRingTransitionRunnerSyscallTraces({
  traceTexts,
  fixtureRoot,
  label,
  expectedLocks,
  expectedLockPids,
  expectedLocksPerPid,
  requireMkdirat = false,
}) {
  if (
    !Array.isArray(traceTexts) ||
    traceTexts.length !== expectedLockPids ||
    expectedLockPids < 2 ||
    expectedLocks !== expectedLockPids * expectedLocksPerPid
  ) {
    throw new Error("[input] concurrent trace bundle shape is invalid");
  }
  const participants = traceTexts.map((traceText, index) =>
    verifyRingTransitionRunnerSyscallTrace({
      traceText,
      fixtureRoot,
      label: `${label} participant ${index + 1}`,
      expectedLocks: expectedLocksPerPid,
      expectedLockPids: 1,
      expectedLocksPerPid,
      requireMutationEvidence: false,
    })
  );
  const observedLockPidValues = participants.flatMap(
    (participant) => participant.observedLockPidValues,
  );
  if (new Set(observedLockPidValues).size !== expectedLockPids) {
    throw new Error(
      `[${label}] concurrent traces do not identify ${expectedLockPids} distinct lock PIDs`,
    );
  }
  const evidence = {
    successfulDirfdOpenat2: participants.some(
      (participant) => participant.successfulDirfdOpenat2,
    ),
    successfulDirfdRenameat2: participants.some(
      (participant) => participant.successfulDirfdRenameat2,
    ),
    successfulDirfdMkdirat: participants.some(
      (participant) => participant.successfulDirfdMkdirat,
    ),
    successfulDirectorySync: participants.some(
      (participant) => participant.successfulDirectorySync,
    ),
    successfulDescriptorChmod: participants.some(
      (participant) => participant.successfulDescriptorChmod,
    ),
  };
  const missing = [];
  if (!evidence.successfulDirfdOpenat2) {
    missing.push("successful_dirfd_openat2");
  }
  if (!evidence.successfulDirfdRenameat2) {
    missing.push("successful_dirfd_renameat2");
  }
  if (!evidence.successfulDirectorySync) {
    missing.push("successful_directory_sync");
  }
  if (!evidence.successfulDescriptorChmod) {
    missing.push("successful_descriptor_chmod");
  }
  if (requireMkdirat && !evidence.successfulDirfdMkdirat) {
    missing.push("successful_dirfd_mkdirat");
  }
  if (missing.length > 0) {
    throw new Error(
      `[${label}] concurrent traces missing required evidence: ${missing.join(", ")}`,
    );
  }

  return {
    ok: true,
    label,
    expectedLocks,
    observedLocks: participants.reduce(
      (total, participant) => total + participant.observedLocks,
      0,
    ),
    observedLockPids: expectedLockPids,
    observedLocksPerPid: participants.flatMap(
      (participant) => participant.observedLocksPerPid,
    ).sort((left, right) => left - right),
    observedLockPidValues: observedLockPidValues.sort(),
    postLockUnconfinedMutation: false,
    ...evidence,
    participants,
  };
}

export function verifyRingTransitionRunnerZeroNetworkTrace({
  traceText,
  label,
  expectedTracePidValues,
  expectedTraceStartPaths,
  expectedTraceFinishPaths,
}) {
  if (typeof label !== "string" || label.length < 1 || label.length > 80) {
    throw new Error("[input] trace label is invalid");
  }
  if (
    !Array.isArray(expectedTracePidValues) ||
    expectedTracePidValues.length < 1 ||
    expectedTracePidValues.length > 64 ||
    expectedTracePidValues.some(
      (pid) => typeof pid !== "string" || !/^[1-9][0-9]*$/u.test(pid),
    ) ||
    new Set(expectedTracePidValues).size !== expectedTracePidValues.length
  ) {
    throw new Error("[input] expected trace PIDs are invalid");
  }
  validateTraceMarkerPaths(
    expectedTraceStartPaths,
    expectedTracePidValues.length,
    "start",
  );
  validateTraceMarkerPaths(
    expectedTraceFinishPaths,
    expectedTracePidValues.length,
    "finish",
  );
  if (
    new Set([...expectedTraceStartPaths, ...expectedTraceFinishPaths]).size !==
    expectedTracePidValues.length * 2
  ) {
    throw new Error("[input] trace marker paths must be distinct");
  }
  if (
    typeof traceText !== "string" ||
    traceText.length < 1 ||
    Buffer.byteLength(traceText, "utf8") > MAX_TRACE_BYTES
  ) {
    throw new Error(`[${label}] trace size is invalid`);
  }

  let parsedSyscalls = 0;
  let scopedParsedSyscalls = 0;
  let unscopedIncompleteTraceLinesObserved = 0;
  let unscopedNetworkSyscallsObserved = 0;
  const observedPidValues = new Set();
  const pendingExpectedSyscalls = new Map();
  const unscopedNetworkSyscallNames = new Set();
  const traceWindows = new Map(
    expectedTracePidValues.map((pid, index) => [
      pid,
      {
        pid,
        startPath: expectedTraceStartPaths[index],
        finishPath: expectedTraceFinishPaths[index],
        started: false,
        active: false,
        finished: false,
      },
    ]),
  );
  for (const rawLine of traceText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("strace:")) {
      throw new Error(`[${label}] incomplete or diagnostic trace line: ${line}`);
    }
    const unfinished = parseUnfinishedSyscallLine(line);
    if (unfinished) {
      observedPidValues.add(unfinished.pid);
      const traceWindow = traceWindows.get(unfinished.pid);
      if (!traceWindow) {
        unscopedIncompleteTraceLinesObserved += 1;
        continue;
      }
      const markerKind = traceMarkerKind(
        unfinished.name,
        line,
        traceWindow,
      );
      if (traceWindow.active) {
        scopedParsedSyscalls += 1;
      }
      if (NETWORK_SYSCALLS.has(unfinished.name) && traceWindow.active) {
        throw new Error(
          `[${label}] forbidden network syscall attempted: ${unfinished.name} by ${unfinished.pid}`,
        );
      }
      if (NETWORK_SYSCALLS.has(unfinished.name)) {
        if (!ALLOWED_UNSCOPED_NETWORK_SYSCALLS.has(unfinished.name)) {
          throw new Error(
            `[${label}] forbidden unscoped network syscall attempted: ${unfinished.name} by ${unfinished.pid}`,
          );
        }
        unscopedNetworkSyscallsObserved += 1;
        unscopedNetworkSyscallNames.add(unfinished.name);
      }
      if (pendingExpectedSyscalls.has(unfinished.pid)) {
        throw new Error(
          `[${label}] overlapping unfinished syscalls for ${unfinished.pid}`,
        );
      }
      pendingExpectedSyscalls.set(unfinished.pid, {
        name: unfinished.name,
        markerKind,
      });
      continue;
    }
    const resumed = parseResumedSyscallLine(line);
    if (resumed) {
      observedPidValues.add(resumed.pid);
      const traceWindow = traceWindows.get(resumed.pid);
      if (!traceWindow) {
        unscopedIncompleteTraceLinesObserved += 1;
        continue;
      }
      const pending = pendingExpectedSyscalls.get(resumed.pid);
      if (!pending || pending.name !== resumed.name) {
        throw new Error(
          `[${label}] resumed syscall has no matching unfinished syscall: ${line}`,
        );
      }
      pendingExpectedSyscalls.delete(resumed.pid);
      if (pending.markerKind) {
        if (!resultIsSuccess(resumed.result)) {
          throw new Error(
            `[${label}] trace ${pending.markerKind} marker failed for ${resumed.pid}`,
          );
        }
        applyTraceMarker(traceWindow, pending.markerKind, label);
      }
      continue;
    }
    if (line.includes("<unfinished ...>") || line.includes("resumed>")) {
      throw new Error(`[${label}] incomplete or diagnostic trace line: ${line}`);
    }
    if (parseProcessTerminationLine(line)) continue;
    if (
      /^(?:(?:\d+\s+)|(?:\[pid\s+\d+\]\s+))?(?:--- |\+\+\+ |Process )/u.test(
        line,
      )
    ) {
      continue;
    }
    const syscall = parseSyscallLine(line);
    if (!syscall) {
      throw new Error(`[${label}] unparsed trace line: ${line}`);
    }
    parsedSyscalls += 1;
    observedPidValues.add(syscall.pid);
    const traceWindow = traceWindows.get(syscall.pid);
    if (traceWindow?.active) {
      scopedParsedSyscalls += 1;
    }
    if (NETWORK_SYSCALLS.has(syscall.name) && traceWindow?.active) {
      throw new Error(
        `[${label}] forbidden network syscall attempted: ${syscall.name} by ${syscall.pid}`,
      );
    }
    if (NETWORK_SYSCALLS.has(syscall.name)) {
      if (!ALLOWED_UNSCOPED_NETWORK_SYSCALLS.has(syscall.name)) {
        throw new Error(
          `[${label}] forbidden unscoped network syscall attempted: ${syscall.name} by ${syscall.pid}`,
        );
      }
      unscopedNetworkSyscallsObserved += 1;
      unscopedNetworkSyscallNames.add(syscall.name);
    }
    if (traceWindow) {
      const markerKind = traceMarkerKind(
        syscall.name,
        syscall.args,
        traceWindow,
      );
      if (markerKind) {
        if (!resultIsSuccess(syscall.result)) {
          throw new Error(
            `[${label}] trace ${markerKind} marker failed for ${syscall.pid}`,
          );
        }
        applyTraceMarker(traceWindow, markerKind, label);
      }
    }
  }
  if (parsedSyscalls === 0) {
    throw new Error(`[${label}] trace contains no parsed syscall`);
  }
  if (pendingExpectedSyscalls.size !== 0) {
    throw new Error(
      `[${label}] unfinished expected-PID syscalls were not resumed: ${[
        ...pendingExpectedSyscalls.entries(),
      ]
        .map(([pid, pending]) => `${pid}:${pending.name}`)
        .join(",")}`,
    );
  }
  const missingPidValues = expectedTracePidValues.filter(
    (pid) => !observedPidValues.has(pid),
  );
  if (missingPidValues.length !== 0 || scopedParsedSyscalls === 0) {
    throw new Error(
      `[${label}] expected trace PIDs were not all observed: ${missingPidValues.join(",")}`,
    );
  }
  for (const traceWindow of traceWindows.values()) {
    if (
      !traceWindow.started ||
      traceWindow.active ||
      !traceWindow.finished
    ) {
      throw new Error(
        `[${label}] trace window is incomplete for ${traceWindow.pid}`,
      );
    }
  }

  return {
    ok: true,
    label,
    networkPolicy: "zero-network-syscalls-for-pinned-windows-v1",
    networkScope: "reported-verify-loaded-credentials-test-thread-windows",
    traceWindowPolicy: "successful-create-new-marker-open-v1",
    parsedSyscalls,
    scopedParsedSyscalls,
    observedProcessIdentities: observedPidValues.size,
    observedPidValues: [...observedPidValues].sort(),
    expectedTracePidValues: [...expectedTracePidValues],
    traceWindows: [...traceWindows.values()].map(
      ({ pid, startPath, finishPath }) => ({
        pid,
        startPath,
        finishPath,
        complete: true,
      }),
    ),
    networkSyscallsObserved: 0,
    networkSyscallNames: [],
    unscopedIncompleteTraceLinesObserved,
    unscopedNetworkSyscallsObserved,
    unscopedNetworkSyscallNames: [...unscopedNetworkSyscallNames].sort(),
    zeroNetworkSyscalls: true,
  };
}

function validateTraceMarkerPaths(values, expectedLength, kind) {
  if (
    !Array.isArray(values) ||
    values.length !== expectedLength ||
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length < 2 ||
        value.length > 4096 ||
        !path.posix.isAbsolute(value) ||
        path.posix.normalize(value) !== value,
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`[input] expected trace ${kind} paths are invalid`);
  }
}

function traceMarkerKind(syscallName, args, traceWindow) {
  if (!["creat", "open", "openat", "openat2"].includes(syscallName)) {
    return null;
  }
  if (args.includes(JSON.stringify(traceWindow.startPath))) {
    return "start";
  }
  if (args.includes(JSON.stringify(traceWindow.finishPath))) {
    return "finish";
  }
  return null;
}

function applyTraceMarker(traceWindow, kind, label) {
  if (
    kind === "start" &&
    !traceWindow.started &&
    !traceWindow.active &&
    !traceWindow.finished
  ) {
    traceWindow.started = true;
    traceWindow.active = true;
    return;
  }
  if (
    kind === "finish" &&
    traceWindow.started &&
    traceWindow.active &&
    !traceWindow.finished
  ) {
    traceWindow.active = false;
    traceWindow.finished = true;
    return;
  }
  throw new Error(
    `[${label}] invalid trace ${kind} marker order for ${traceWindow.pid}`,
  );
}

function observeTerminalCandidateEvidence({
  syscall,
  index,
  root,
  label,
  descriptorState,
  evidence,
}) {
  if (
    syscall.name === "renameat2" &&
    /,\s*"terminal-snapshot-candidate\.json"\s*,\s*RENAME_NOREPLACE\s*$/u.test(
      syscall.args,
    )
  ) {
    for (const descriptor of renameDescriptors(
      syscall.args,
      syscall.pid,
      descriptorState,
    )) {
      requireTerminalCandidateClosureDescriptor(descriptor, root, label);
    }
    evidence.terminalCandidatePid = syscall.pid;
    evidence.terminalCandidateRenameAt = index;
    return;
  }
  if (
    syscall.name === "openat2" &&
    !isWriteOpen(syscall) &&
    /^\s*\d+(?:<[^>]*>)?,\s*"terminal-snapshot-candidate\.json",/u.test(
      syscall.args,
    ) &&
    evidence.terminalCandidateRenameAt !== null
  ) {
    if (syscall.pid !== evidence.terminalCandidatePid) {
      throw new Error(
        `[${label}] terminal candidate readback moved to another process`,
      );
    }
    const descriptor = descriptorArgument(
      syscall.args,
      syscall.pid,
      descriptorState,
    );
    requireTerminalCandidateClosureDescriptor(descriptor, root, label);
    const opened = parseDescriptorToken(syscall.result);
    if (
      !opened ||
      path.posix.basename(normalizeTracePath(opened.path) ?? "") !==
        "terminal-snapshot-candidate.json"
    ) {
      throw new Error(
        `[${label}] terminal candidate readback descriptor is not object-bound`,
      );
    }
    if (
      evidence.terminalCandidateDirectorySyncAt !== null &&
      index > evidence.terminalCandidateDirectorySyncAt &&
      evidence.terminalCandidateReadbackAt === null
    ) {
      evidence.terminalCandidateReadbackAt = index;
    }
    return;
  }
  if (
    ["fsync", "fdatasync"].includes(syscall.name) &&
    evidence.terminalCandidateRenameAt !== null &&
    evidence.terminalCandidateDirectorySyncAt === null &&
    syscall.pid === evidence.terminalCandidatePid
  ) {
    const descriptor = descriptorArgument(
      syscall.args,
      syscall.pid,
      descriptorState,
    );
    if (
      descriptor.isDirectory &&
      isTerminalCandidateClosurePath(root, descriptor.path)
    ) {
      evidence.terminalCandidateDirectorySyncAt = index;
    }
  }
}

function requireTerminalCandidateClosureDescriptor(
  descriptor,
  root,
  label,
) {
  if (
    !descriptor?.isDirectory ||
    !isTerminalCandidateClosurePath(root, descriptor.path)
  ) {
    throw new Error(
      `[${label}] terminal candidate operation is not bound to its closure directory`,
    );
  }
}

function isTerminalCandidateClosurePath(root, value) {
  return isWithinFixture(root, value) &&
    path.posix.basename(path.posix.dirname(value)) ===
      "execution-operation-closures";
}

function verifySuccessfulMutation({
  syscall,
  root,
  label,
  descriptorState,
  heldLocks,
  evidence,
}) {
  const writeOpen = isWriteOpen(syscall);
  if (
    LEGACY_PATH_MUTATIONS.has(syscall.name) &&
    (syscall.name !== "open" || writeOpen)
  ) {
    throw new Error(
      `[${label}] successful post-lock legacy pathname mutation: ${syscall.raw}`,
    );
  }
  if (
    syscall.name === "openat" &&
    writeOpen
  ) {
    throw new Error(
      `[${label}] successful post-lock openat write is not openat2-confined: ${syscall.raw}`,
    );
  }
  if (
    syscall.name === "openat2" &&
    syscall.args.includes("AT_FDCWD")
  ) {
    throw new Error(
      `[${label}] successful post-lock openat2 used AT_FDCWD: ${syscall.raw}`,
    );
  }

  const pathMutation =
    (syscall.name === "openat2" && writeOpen) ||
    [
      "fchmodat",
      "fchownat",
      "linkat",
      "mkdirat",
      "mknodat",
      "renameat",
      "renameat2",
      "symlinkat",
      "unlinkat",
      "utimensat",
    ].includes(syscall.name);
  if (pathMutation) {
    if (!ALLOWED_DIRFD_MUTATIONS.has(syscall.name)) {
      throw new Error(
        `[${label}] unexpected successful post-lock path mutation: ${syscall.raw}`,
      );
    }
    if (syscall.args.includes("AT_FDCWD")) {
      throw new Error(
        `[${label}] successful post-lock mutation used AT_FDCWD: ${syscall.raw}`,
      );
    }
    requireTwoLocks(heldLocks, syscall.pid, label, syscall.raw);
    const descriptors =
      syscall.name === "renameat2"
        ? renameDescriptors(syscall.args, syscall.pid, descriptorState)
        : [
            descriptorArgument(
              syscall.args,
              syscall.pid,
              descriptorState,
            ),
          ];
    for (const descriptor of descriptors) {
      requireFixtureDescriptor(
        descriptor,
        root,
        label,
        `${syscall.name} dirfd`,
      );
    }
    if (syscall.name === "openat2") evidence.dirfdOpenat2 = true;
    if (syscall.name === "renameat2") evidence.dirfdRenameat2 = true;
    if (syscall.name === "mkdirat") evidence.dirfdMkdirat = true;
  }

  if (syscall.name === "fchmod") {
    requireTwoLocks(heldLocks, syscall.pid, label, syscall.raw);
    const descriptor = descriptorArgument(
      syscall.args,
      syscall.pid,
      descriptorState,
    );
    requireFixtureDescriptor(descriptor, root, label, "fchmod descriptor");
    evidence.descriptorChmod = true;
  }

  if (
    ["fchown", "fremovexattr", "fsetxattr", "ftruncate"].includes(
      syscall.name,
    )
  ) {
    throw new Error(
      `[${label}] unexpected successful post-lock descriptor mutation: ${syscall.raw}`,
    );
  }

  if (syscall.name === "fsync" || syscall.name === "fdatasync") {
    const descriptor = descriptorArgument(
      syscall.args,
      syscall.pid,
      descriptorState,
    );
    if (
      descriptor.isDirectory &&
      isWithinFixture(root, descriptor.path)
    ) {
      requireTwoLocks(heldLocks, syscall.pid, label, syscall.raw);
      evidence.directorySync = true;
    }
  }
}

function verifyExclusiveLockPairs(locks, root, label, expectedLocks) {
  if (locks.length !== expectedLocks) {
    throw new Error(
      `[${label}] expected exactly ${expectedLocks} successful exclusive locks, found ${locks.length}`,
    );
  }
  let expectedReceiptsPath = null;
  let expectedAuthorizationPath = null;
  for (let index = 0; index < locks.length; index += 2) {
    const receipts = locks[index];
    const authorization = locks[index + 1];
    if (
      path.posix.basename(receipts.path) !== "execution-operation-receipts" ||
      path.posix.dirname(authorization.path) !== receipts.path ||
      receipts.pid !== authorization.pid ||
      !isWithinFixture(root, receipts.path) ||
      !isWithinFixture(root, authorization.path)
    ) {
      throw new Error(`[${label}] exclusive locks are not a receipts/authorization pair`);
    }
    expectedReceiptsPath ??= receipts.path;
    expectedAuthorizationPath ??= authorization.path;
    if (
      receipts.path !== expectedReceiptsPath ||
      authorization.path !== expectedAuthorizationPath
    ) {
      throw new Error(`[${label}] exclusive lock identity drift`);
    }
  }
}

function rememberDescriptor(syscall, descriptorState) {
  if (["open", "openat", "openat2"].includes(syscall.name)) {
    const result = parseDescriptorToken(syscall.result);
    if (result && resultIsSuccess(syscall.result)) {
      descriptorState.set(descriptorKey(syscall.pid, result.fd), {
        fd: result.fd,
        path: normalizeTracePath(result.path),
        isDirectory: syscall.args.includes("O_DIRECTORY"),
      });
    }
    return;
  }
  if (["dup", "dup2", "dup3"].includes(syscall.name)) {
    const source = descriptorArgument(
      syscall.args,
      syscall.pid,
      descriptorState,
      false,
    );
    const result = parseDescriptorToken(syscall.result);
    if (source && result && resultIsSuccess(syscall.result)) {
      descriptorState.set(descriptorKey(syscall.pid, result.fd), {
        ...source,
        fd: result.fd,
      });
    }
    return;
  }
  if (
    syscall.name === "fcntl" &&
    syscall.args.includes("F_DUPFD") &&
    resultIsSuccess(syscall.result)
  ) {
    const source = descriptorArgument(
      syscall.args,
      syscall.pid,
      descriptorState,
      false,
    );
    const result = parseDescriptorToken(syscall.result);
    if (source && result) {
      descriptorState.set(descriptorKey(syscall.pid, result.fd), {
        ...source,
        fd: result.fd,
      });
    }
  }
}

function parseSyscallLine(raw) {
  const match =
    /^(?:(\d+)\s+|\[pid\s+(\d+)\]\s+)?([A-Za-z_][A-Za-z0-9_]*)\((.*)\)\s+=\s+(.+)$/u.exec(
      raw,
    );
  if (!match) return null;
  return {
    raw,
    pid: match[1] ?? match[2] ?? "main",
    name: match[3],
    args: match[4],
    result: match[5],
  };
}

function parseUnfinishedSyscallLine(raw) {
  const match =
    /^(?:(\d+)\s+|\[pid\s+(\d+)\]\s+)([A-Za-z_][A-Za-z0-9_]*)\(.*<unfinished \.\.\.>$/u.exec(
      raw,
    );
  if (!match) return null;
  return {
    pid: match[1] ?? match[2],
    name: match[3],
  };
}

function parseResumedSyscallLine(raw) {
  const match =
    /^(?:(\d+)\s+|\[pid\s+(\d+)\]\s+)<\.\.\. ([A-Za-z_][A-Za-z0-9_]*) resumed>.*\)\s+=\s+(.+)$/u.exec(
      raw,
    );
  if (!match) return null;
  return {
    pid: match[1] ?? match[2],
    name: match[3],
    result: match[4],
  };
}

function parseProcessTerminationLine(raw) {
  const match =
    /^(?:(\d+)\s+|\[pid\s+(\d+)\]\s+)?\+\+\+ (?:(?:killed by (SIG[A-Z0-9]+))|(?:exited with (\d+))) \+\+\+$/u.exec(
      raw,
    );
  if (!match) return null;
  return {
    pid: match[1] ?? match[2] ?? "main",
    signal: match[3] ?? null,
    exitCode: match[4] === undefined ? null : Number(match[4]),
  };
}

function resultIsSuccess(result) {
  const match = /^(-?\d+)/u.exec(result.trim());
  return Boolean(match && Number(match[1]) >= 0);
}

function isWriteOpen(syscall) {
  return ["creat", "open", "openat", "openat2"].includes(syscall.name) &&
    WRITE_FLAGS.some((flag) => syscall.args.includes(flag));
}

function descriptorArgument(
  args,
  pid,
  descriptorState,
  required = true,
) {
  const parsed = parseDescriptorToken(args);
  if (!parsed) {
    if (required) throw new Error("[trace] numeric descriptor is required");
    return null;
  }
  const remembered = descriptorState.get(descriptorKey(pid, parsed.fd));
  return {
    fd: parsed.fd,
    path: normalizeTracePath(parsed.path ?? remembered?.path),
    isDirectory: remembered?.isDirectory === true,
  };
}

function renameDescriptors(args, pid, descriptorState) {
  const match =
    /^\s*(\d+)(?:<([^>]*)>)?,\s*"[^"]*"\s*,\s*(\d+)(?:<([^>]*)>)?,/u.exec(
      args,
    );
  if (!match) throw new Error("[trace] renameat2 descriptors are invalid");
  return [
    descriptorFromParts(match[1], match[2], pid, descriptorState),
    descriptorFromParts(match[3], match[4], pid, descriptorState),
  ];
}

function descriptorFromParts(fdText, annotatedPath, pid, descriptorState) {
  const fd = Number(fdText);
  const remembered = descriptorState.get(descriptorKey(pid, fd));
  return {
    fd,
    path: normalizeTracePath(annotatedPath ?? remembered?.path),
    isDirectory: remembered?.isDirectory === true,
  };
}

function parseDescriptorToken(text) {
  const match = /^\s*(\d+)(?:<([^>]*)>)?/u.exec(text);
  if (!match) return null;
  return {
    fd: Number(match[1]),
    path: match[2],
  };
}

function requireFixtureDescriptor(descriptor, root, label, purpose) {
  if (
    !descriptor ||
    !Number.isSafeInteger(descriptor.fd) ||
    !isWithinFixture(root, descriptor.path)
  ) {
    throw new Error(`[${label}] ${purpose} is not bound beneath the fixture root`);
  }
}

function requireTwoLocks(heldLocks, pid, label, raw) {
  if (locksFor(heldLocks, pid).size < 2) {
    throw new Error(`[${label}] mutation occurred without both locks: ${raw}`);
  }
}

function locksFor(heldLocks, pid) {
  let locks = heldLocks.get(pid);
  if (!locks) {
    locks = new Map();
    heldLocks.set(pid, locks);
  }
  return locks;
}

function descriptorKey(pid, fd) {
  return `${pid}:${fd}`;
}

function normalizeFixtureRoot(value) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 4096 ||
    !value.startsWith("/")
  ) {
    throw new Error("[input] fixture root must be an absolute Linux path");
  }
  return path.posix.resolve(value);
}

function normalizeTracePath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  return path.posix.resolve(value.replace(/\\([0-7]{3})/gu, "?"));
}

function isWithinFixture(root, value) {
  return typeof value === "string" &&
    (value === root || value.startsWith(`${root}/`));
}

function parseArgs(argv) {
  const values = new Map();
  let requireMkdirat = false;
  let requireSigkillExit = false;
  let requireTerminalCandidateSync = false;
  let requireZeroNetwork = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-mkdirat") {
      requireMkdirat = true;
      continue;
    }
    if (argument === "--require-sigkill-exit") {
      requireSigkillExit = true;
      continue;
    }
    if (argument === "--require-terminal-candidate-sync") {
      requireTerminalCandidateSync = true;
      continue;
    }
    if (argument === "--require-zero-network") {
      requireZeroNetwork = true;
      continue;
    }
    if (
      ![
        "--trace",
        "--peer-trace",
        "--fixture-root",
        "--label",
        "--expected-locks",
        "--expected-lock-pids",
        "--expected-locks-per-pid",
        "--expected-trace-pids",
        "--expected-trace-start-paths",
        "--expected-trace-finish-paths",
      ].includes(argument)
    ) {
      usage(2, `[input] unknown argument: ${argument}`);
    }
    if (values.has(argument) || index + 1 >= argv.length) {
      usage(2, `[input] invalid argument: ${argument}`);
    }
    values.set(argument, argv[++index]);
  }
  for (const name of ["--trace", "--label"]) {
    if (!values.has(name)) usage(2, `[input] missing argument: ${name}`);
  }
  if (requireZeroNetwork) {
    if (
      values.has("--peer-trace") ||
      values.has("--fixture-root") ||
      values.has("--expected-locks") ||
      values.has("--expected-lock-pids") ||
      values.has("--expected-locks-per-pid") ||
      requireMkdirat ||
      requireSigkillExit ||
      requireTerminalCandidateSync
    ) {
      usage(2, "[input] zero-network trace arguments are invalid");
    }
    for (const name of [
      "--expected-trace-pids",
      "--expected-trace-start-paths",
      "--expected-trace-finish-paths",
    ]) {
      if (!values.has(name)) usage(2, `[input] missing argument: ${name}`);
    }
    const expectedTracePidValues = values
      .get("--expected-trace-pids")
      .split(",");
    const expectedTraceStartPaths = values
      .get("--expected-trace-start-paths")
      .split(",");
    const expectedTraceFinishPaths = values
      .get("--expected-trace-finish-paths")
      .split(",");
    return {
      tracePath: values.get("--trace"),
      peerTracePath: null,
      fixtureRoot: null,
      label: values.get("--label"),
      expectedLocks: null,
      expectedLockPids: null,
      expectedLocksPerPid: null,
      requireMkdirat: false,
      requireSigkillExit: false,
      requireTerminalCandidateSync: false,
      requireZeroNetwork: true,
      expectedTracePidValues,
      expectedTraceStartPaths,
      expectedTraceFinishPaths,
    };
  }
  if (
    values.has("--expected-trace-pids") ||
    values.has("--expected-trace-start-paths") ||
    values.has("--expected-trace-finish-paths")
  ) {
    usage(2, "[input] zero-network trace arguments are invalid");
  }
  for (const name of ["--fixture-root", "--expected-locks"]) {
    if (!values.has(name)) usage(2, `[input] missing argument: ${name}`);
  }
  const expectedLocks = Number(values.get("--expected-locks"));
  const expectedLockPids = values.has("--expected-lock-pids")
    ? Number(values.get("--expected-lock-pids"))
    : null;
  const expectedLocksPerPid = values.has("--expected-locks-per-pid")
    ? Number(values.get("--expected-locks-per-pid"))
    : null;
  return {
    tracePath: values.get("--trace"),
    peerTracePath: values.get("--peer-trace") ?? null,
    fixtureRoot: values.get("--fixture-root"),
    label: values.get("--label"),
    expectedLocks,
    expectedLockPids,
    expectedLocksPerPid,
    requireMkdirat,
    requireSigkillExit,
    requireTerminalCandidateSync,
    requireZeroNetwork: false,
    expectedTracePidValues: null,
    expectedTraceStartPaths: null,
    expectedTraceFinishPaths: null,
  };
}

function usage(exitCode, message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: node tools/verify_ring_transition_runner_syscall_trace.mjs " +
      "--trace <path> --fixture-root <path> --label <label> " +
      "--expected-locks <even-count> [--require-mkdirat] " +
      "[--peer-trace <path>] " +
      "[--expected-lock-pids <count> --expected-locks-per-pid <even-count>] " +
      "[--require-sigkill-exit] [--require-terminal-candidate-sync]\n" +
      "   or: node tools/verify_ring_transition_runner_syscall_trace.mjs " +
      "--trace <path> --label <label> --expected-trace-pids <pid,...> " +
      "--expected-trace-start-paths <path,...> " +
      "--expected-trace-finish-paths <path,...> " +
      "--require-zero-network\n",
  );
  process.exit(exitCode);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const trace = await readFile(options.tracePath);
    if (trace.length < 1 || trace.length > MAX_TRACE_BYTES) {
      throw new Error(`[${options.label}] trace size is invalid`);
    }
    let result;
    if (options.requireZeroNetwork) {
      result = verifyRingTransitionRunnerZeroNetworkTrace({
        traceText: trace.toString("utf8"),
        label: options.label,
        expectedTracePidValues: options.expectedTracePidValues,
        expectedTraceStartPaths: options.expectedTraceStartPaths,
        expectedTraceFinishPaths: options.expectedTraceFinishPaths,
      });
    } else if (options.peerTracePath !== null) {
      if (
        options.expectedLockPids === null ||
        options.expectedLocksPerPid === null ||
        options.requireSigkillExit ||
        options.requireTerminalCandidateSync
      ) {
        throw new Error("[input] concurrent trace bundle arguments are invalid");
      }
      const peerTrace = await readFile(options.peerTracePath);
      if (peerTrace.length < 1 || peerTrace.length > MAX_TRACE_BYTES) {
        throw new Error(`[${options.label}] peer trace size is invalid`);
      }
      result = verifyConcurrentRingTransitionRunnerSyscallTraces({
        ...options,
        traceTexts: [trace.toString("utf8"), peerTrace.toString("utf8")],
      });
    } else {
      result = verifyRingTransitionRunnerSyscallTrace({
        ...options,
        traceText: trace.toString("utf8"),
      });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "trace verification failed"}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
