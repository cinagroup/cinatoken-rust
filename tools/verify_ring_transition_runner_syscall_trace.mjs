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

export function verifyRingTransitionRunnerSyscallTrace({
  traceText,
  fixtureRoot,
  label,
  expectedLocks,
  requireMkdirat = false,
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
  };
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
  const missing = [];
  if (!evidence.dirfdOpenat2) missing.push("successful_dirfd_openat2");
  if (!evidence.dirfdRenameat2) missing.push("successful_dirfd_renameat2");
  if (!evidence.directorySync) missing.push("successful_directory_sync");
  if (!evidence.descriptorChmod) missing.push("successful_descriptor_chmod");
  if (requireMkdirat && !evidence.dirfdMkdirat) {
    missing.push("successful_dirfd_mkdirat");
  }
  if (missing.length > 0) {
    throw new Error(`[${label}] trace missing required evidence: ${missing.join(", ")}`);
  }

  return {
    ok: true,
    label,
    expectedLocks,
    observedLocks: exclusiveLocks.length,
    postLockUnconfinedMutation: false,
    successfulDirfdOpenat2: evidence.dirfdOpenat2,
    successfulDirfdRenameat2: evidence.dirfdRenameat2,
    successfulDirfdMkdirat: evidence.dirfdMkdirat,
    successfulDirectorySync: evidence.directorySync,
    successfulDescriptorChmod: evidence.descriptorChmod,
  };
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
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-mkdirat") {
      requireMkdirat = true;
      continue;
    }
    if (
      ![
        "--trace",
        "--fixture-root",
        "--label",
        "--expected-locks",
      ].includes(argument)
    ) {
      usage(2, `[input] unknown argument: ${argument}`);
    }
    if (values.has(argument) || index + 1 >= argv.length) {
      usage(2, `[input] invalid argument: ${argument}`);
    }
    values.set(argument, argv[++index]);
  }
  for (const name of [
    "--trace",
    "--fixture-root",
    "--label",
    "--expected-locks",
  ]) {
    if (!values.has(name)) usage(2, `[input] missing argument: ${name}`);
  }
  const expectedLocks = Number(values.get("--expected-locks"));
  return {
    tracePath: values.get("--trace"),
    fixtureRoot: values.get("--fixture-root"),
    label: values.get("--label"),
    expectedLocks,
    requireMkdirat,
  };
}

function usage(exitCode, message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: node tools/verify_ring_transition_runner_syscall_trace.mjs " +
      "--trace <path> --fixture-root <path> --label <label> " +
      "--expected-locks <even-count> [--require-mkdirat]\n",
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
    const result = verifyRingTransitionRunnerSyscallTrace({
      ...options,
      traceText: trace.toString("utf8"),
    });
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
