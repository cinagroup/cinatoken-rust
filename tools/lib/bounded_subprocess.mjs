import { spawn, spawnSync } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 1_000;

export class BoundedSubprocessError extends Error {}

export async function runBoundedSubprocess(
  command,
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
  } = {},
) {
  requireNonEmptyString(command, "command");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new BoundedSubprocessError("subprocess arguments must be a string array");
  }
  requireSafeInteger(maxOutputBytes, 1, 16 * 1024 * 1024, "max output bytes");
  requireSafeInteger(timeoutMs, 50, 300_000, "timeout");
  requireSafeInteger(killGraceMs, 50, 10_000, "kill grace");
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new BoundedSubprocessError("subprocess environment must be an object");
  }

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(failedSpawnResult());
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let terminationReason = null;
    let timeoutId;
    let forceFinishId;

    const result = (exitCode) => {
      const outputLimitExceeded = terminationReason === "output-limit";
      const timedOut = terminationReason === "timeout";
      let invalidUtf8 = false;
      let stdoutText = "";
      let stderrText = "";
      if (!outputLimitExceeded && !timedOut) {
        try {
          stdoutText = decodeUtf8(Buffer.concat(stdout));
          stderrText = decodeUtf8(Buffer.concat(stderr));
        } catch {
          invalidUtf8 = true;
        }
      }
      return {
        exitCode,
        stdout: invalidUtf8 ? "" : stdoutText,
        stderr: invalidUtf8 ? "" : stderrText,
        outputBytes,
        outputLimitExceeded,
        timedOut,
        invalidUtf8,
        terminationReason,
      };
    };

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(forceFinishId);
      resolve(result(exitCode));
    };

    const terminate = (reason) => {
      if (terminationReason !== null || settled) return;
      terminationReason = reason;
      terminateProcessTree(child);
      forceFinishId = setTimeout(() => finish(null), killGraceMs);
    };

    const capture = (chunks) => (chunk) => {
      if (settled || terminationReason !== null) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate("output-limit");
        return;
      }
      chunks.push(Buffer.from(chunk));
    };

    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", () => finish(null));
    child.once("close", (exitCode) => finish(exitCode));
    timeoutId = setTimeout(() => terminate("timeout"), timeoutMs);
  });
}

export function terminateProcessTree(child) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The process can exit between the limit check and termination.
  }
}

function failedSpawnResult() {
  return {
    exitCode: null,
    stdout: "",
    stderr: "",
    outputBytes: 0,
    outputLimitExceeded: false,
    timedOut: false,
    invalidUtf8: false,
    terminationReason: "spawn-error",
  };
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new BoundedSubprocessError(`subprocess ${label} must be a nonempty string`);
  }
}

function requireSafeInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BoundedSubprocessError(
      `subprocess ${label} must be between ${minimum} and ${maximum}`,
    );
  }
}
