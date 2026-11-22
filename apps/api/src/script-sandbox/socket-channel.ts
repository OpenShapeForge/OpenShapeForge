// SPDX-License-Identifier: BUSL-1.1
/**
 * Trusted internal connector to the sandbox daemon's private Unix socket. One
 * socket carries exactly one run and the same binary frame protocol as the
 * local subprocess; the broker (`runScriptWith`) keeps the per-run deadline,
 * cancellation and read budget. Any connect failure, abort or close fails the
 * run closed; there is no fallback to the local subprocess.
 *
 * Admission is by filesystem permission on the dedicated socket volume (the
 * protocol carries no token). Never point this at a path an untrusted party can
 * write to.
 */
import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import type { OpenWorkerChannel, WorkerChannel } from "./channel.js";
import type { JsonValue } from "./protocol.js";
import { runScriptWith, type RunScriptRequest } from "./run-script.js";

// sockaddr_un.sun_path is 104 bytes on macOS and 108 on Linux.
const MAX_SOCKET_PATH_BYTES = 100;

export function createSocketOpener(socketPath: string): OpenWorkerChannel {
  if (typeof socketPath !== "string" || !isAbsolute(socketPath) || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error("Script sandbox socket path must be an absolute path of at most 100 bytes");
  }
  return ({ signal }) => new Promise<WorkerChannel>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    // allowHalfOpen: after our FIN the daemon may still deliver the final frames.
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    const onAbort = () => { socket.destroy(); reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("error", error => { signal.removeEventListener("abort", onAbort); reject(error); });
    socket.once("connect", () => {
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners("error");
      resolve(socketChannel(socket));
    });
  });
}

/** A runner bound to one sandbox daemon socket. */
export function createSandboxRunner(socketPath: string): (request: RunScriptRequest) => Promise<JsonValue> {
  const open = createSocketOpener(socketPath);
  return request => runScriptWith(open, request);
}

function socketChannel(socket: Socket): WorkerChannel {
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  socket.on("error", () => socket.destroy()); // reported to the broker as a closed stream or a failed write
  return {
    write: frame => new Promise<void>((resolve, reject) => {
      if (socket.destroyed || !socket.writable) return reject(new Error("closed"));
      // The callback fires once the kernel accepted the bytes, so awaiting it is the backpressure.
      socket.write(frame, error => (error ? reject(error) : resolve()));
    }),
    output: socket,
    end: () => { if (!socket.destroyed && socket.writable) socket.end(); },
    kill: () => { socket.destroy(); },
    closed,
  };
}
