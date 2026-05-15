import { NextRequest } from 'next/server';
import net from 'node:net';
import { loadConfig } from '@tenda/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const cfg = loadConfig();
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      send({ type: 'hello', ts: Date.now() });

      let sock: net.Socket | null = null;
      let pingTimer: NodeJS.Timeout | null = null;

      const connectIpc = () => {
        try {
          sock = net.createConnection(cfg.ipcSocket);
          let buf = '';
          sock.on('data', (chunk) => {
            buf += chunk.toString('utf-8');
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line) continue;
              try { send(JSON.parse(line)); } catch {}
            }
          });
          sock.on('error', () => {});
          sock.on('close', () => {
            sock = null;
            setTimeout(connectIpc, 2000);
          });
        } catch {}
      };
      connectIpc();

      pingTimer = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`)); } catch {}
      }, 15000);

      const abort = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (sock) sock.destroy();
        try { controller.close(); } catch {}
      };
      req.signal.addEventListener('abort', abort);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
