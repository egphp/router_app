import net from 'node:net';
import fs from 'node:fs';
import type { IpcMessage } from '@tenda/shared';
import { log } from './logger.js';

export class IpcBroadcaster {
  private server: net.Server;
  private clients = new Set<net.Socket>();

  constructor(private readonly socketPath: string) {
    try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch {}
    this.server = net.createServer((sock) => {
      this.clients.add(sock);
      sock.on('close', () => this.clients.delete(sock));
      sock.on('error', () => this.clients.delete(sock));
    });
    this.server.on('error', (err) => log.error('ipc server error', String(err)));
    this.server.listen(socketPath, () => log.info('ipc: listening', { socketPath }));
    try { fs.chmodSync(socketPath, 0o660); } catch {}
  }

  broadcast(msg: IpcMessage): void {
    const line = JSON.stringify(msg) + '\n';
    for (const c of this.clients) {
      try { c.write(line); } catch {}
    }
  }

  close(): void {
    for (const c of this.clients) { try { c.destroy(); } catch {} }
    this.server.close();
  }
}
