import { EventEmitter } from 'node:events';

/**
 * Two connected in-memory sockets with the part of the `ws` WebSocket interface
 * the gateway uses (send, close, terminate, ping, readyState, and the message /
 * close / pong / error events). A virtual charger holds one end; the gateway's
 * normal connection handler gets the other, so everything above the transport
 * is the code a real charger meets. Delivery is asynchronous, like a network.
 */
export class MemorySocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = MemorySocket.OPEN;
  peer!: MemorySocket;
  /** Sub-protocol, for parity with ws. */
  protocol = '';

  send(data: string | Buffer): void {
    if (this.readyState !== MemorySocket.OPEN) return;
    const text = typeof data === 'string' ? data : data.toString('utf8');
    setImmediate(() => {
      if (this.peer.readyState === MemorySocket.OPEN) this.peer.emit('message', Buffer.from(text, 'utf8'), false);
    });
  }

  /** The peer answers pings itself, as a WebSocket stack does. */
  ping(): void {
    if (this.readyState !== MemorySocket.OPEN) return;
    setImmediate(() => {
      if (this.peer.readyState === MemorySocket.OPEN) this.emit('pong');
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MemorySocket.CLOSED) return;
    this.readyState = MemorySocket.CLOSED;
    const peer = this.peer;
    setImmediate(() => {
      this.emit('close', code, Buffer.from(reason));
      if (peer.readyState !== MemorySocket.CLOSED) {
        peer.readyState = MemorySocket.CLOSED;
        peer.emit('close', code, Buffer.from(reason));
      }
    });
  }

  terminate(): void {
    this.close(1006, 'terminated');
  }
}

export function socketPair(protocol: string): [client: MemorySocket, server: MemorySocket] {
  const a = new MemorySocket();
  const b = new MemorySocket();
  a.peer = b;
  b.peer = a;
  a.protocol = b.protocol = protocol;
  return [a, b];
}
