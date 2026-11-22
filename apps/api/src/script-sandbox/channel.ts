// SPDX-License-Identifier: BUSL-1.1
/**
 * The byte channel between the parent broker (`runScriptWith`) and one fresh
 * worker. Two implementations exist: a local subprocess (internal test
 * fixture) and a Unix-domain socket to the sandbox daemon. The broker owns the
 * deadline, cancellation and read budget for both; a channel only moves bytes.
 */
export interface WorkerChannel {
  /** Resolves once the frame is accepted by the transport (backpressure); rejects when it is closed. */
  write(frame: Uint8Array): Promise<void>;
  /** Raw bytes from the worker. Ends when the worker side closes. */
  output: AsyncIterable<Uint8Array>;
  /** Half-close: no more bytes follow from the parent. The worker may still answer. */
  end(): void;
  /** Tear down immediately and idempotently. */
  kill(): void;
  /** Settles after the worker side is gone and every resource of the channel is released. */
  closed: Promise<unknown>;
}

export interface OpenChannelContext {
  /** Aborted when the run ends for any reason, including while the channel is still opening. */
  signal: AbortSignal;
}

/** Opens a channel to a fresh worker. A rejection means no worker exists and fails the run closed. */
export type OpenWorkerChannel = (context: OpenChannelContext) => Promise<WorkerChannel>;
