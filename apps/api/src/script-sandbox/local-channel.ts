// SPDX-License-Identifier: BUSL-1.1
/**
 * Local subprocess channel: an internal fixture mechanism only. It shares the
 * API's uid, filesystem view and network namespace, so it is not a deployment
 * boundary; production use goes through the container socket connector.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenWorkerChannel, WorkerChannel } from "./channel.js";

export const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

const liveWorkers = new Set<{ kill(signal?: number | NodeJS.Signals): void }>();
let exitHookInstalled = false;
function track(worker: { kill(signal?: number | NodeJS.Signals): void }) {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => { for (const live of liveWorkers) { try { live.kill("SIGKILL"); } catch { /* already gone */ } } });
  }
  liveWorkers.add(worker);
}

function spawnWorker(cwd: string) {
  return Bun.spawn([process.execPath, WORKER_PATH], { cwd, env: {}, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
}

export const openLocalWorker: OpenWorkerChannel = async () => {
  // An empty directory as cwd and an empty environment: nothing ambient to read or inherit.
  const cwd = await mkdtemp(join(tmpdir(), "osf-script-"));
  let worker: ReturnType<typeof spawnWorker>;
  try {
    worker = spawnWorker(cwd);
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
  track(worker);
  const channel: WorkerChannel = {
    async write(frame) {
      worker.stdin.write(frame);
      await worker.stdin.flush();
    },
    output: workerOutput(worker.stdout),
    end() { try { worker.stdin.end(); } catch { /* pipe already closed */ } },
    kill() { try { worker.kill("SIGKILL"); } catch { /* already gone */ } },
    closed: worker.exited.then(async () => {
      liveWorkers.delete(worker);
      await rm(cwd, { recursive: true, force: true });
    }),
  };
  return channel;
};

async function* workerOutput(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}
