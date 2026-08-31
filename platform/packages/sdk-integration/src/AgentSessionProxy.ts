/**
 * AgentSessionProxy — server-side proxy that turns IPC calls into
 * "looks like a normal AgentSession" calls.
 *
 * The method names map 1:1 to pi SDK AgentSession methods.
 * Each method sends a CallRequest over the worker IPC channel and awaits the response.
 */

import type { WorkerMethod } from '@pi-agent-platform/ipc-protocol';
import type { CallRequest, CallResponse, WorkerEvent } from '@pi-agent-platform/ipc-protocol';

type SendFn = (req: CallRequest) => Promise<CallResponse>;

export interface AgentSessionProxyOptions {
  send: SendFn;
  sessionHandle: string;
  onEvent?: (event: WorkerEvent) => void;
}

export class AgentSessionProxy {
  private nextCallId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly opts: AgentSessionProxyOptions) {}

  /** Handle incoming WorkerEvent from worker process */
  receive(event: WorkerEvent): void {
    if (event.kind === 'event') {
      this.opts.onEvent?.(event);
    }
  }

  // ----- SDK method surface -----

  async prompt(message: string, images?: unknown[]): Promise<void> {
    await this.call('prompt', [message, images]);
  }

  async abort(): Promise<void> {
    await this.call('abort', []);
  }

  async setModel(model: string): Promise<void> {
    await this.call('setModel', [model]);
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.call('setThinkingLevel', [level]);
  }

  async setTools(tools: string[]): Promise<void> {
    await this.call('setTools', [tools]);
  }

  // ----- internal -----

  private async call(method: WorkerMethod, args: unknown[]): Promise<unknown> {
    const id = this.nextCallId++;
    const req: CallRequest = { kind: 'call', id, method, args };
    const res = await this.opts.send(req);
    if (res.kind !== 'response' || res.id !== id) {
      throw new Error(`unexpected IPC response: ${JSON.stringify(res)}`);
    }
    if (!res.ok) {
      throw new Error(res.error.message);
    }
    return res.result;
  }
}