import { NextResponse } from 'next/server';
import { runCopilotTurn, type CopilotTurnMessage } from '@tenda/shared';
import { db } from '../../../../lib/db';
import { guardApiRequest } from '../../../../lib/remote-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;

  let body: {
    message?: unknown;
    history?: unknown;
    pageContext?: { pathname?: unknown; focusedMac?: unknown };
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 4000) : '';
  if (!message) {
    return NextResponse.json({ ok: false, error: 'Message is required' }, { status: 400 });
  }

  const history: CopilotTurnMessage[] = Array.isArray(body.history)
    ? body.history
        .filter(
          (item): item is { role: 'user' | 'assistant' | 'model'; content: string } =>
            Boolean(item) &&
            typeof item === 'object' &&
            ((item as any).role === 'user' ||
              (item as any).role === 'assistant' ||
              (item as any).role === 'model') &&
            typeof (item as any).content === 'string',
        )
        .slice(-10)
        .map((h) => ({
          role: h.role === 'user' ? 'user' : 'assistant',
          content: h.content.slice(0, 4000),
        }))
    : [];

  const conn = db();
  const turn = await runCopilotTurn(conn, {
    message,
    history,
    pageContext: {
      pathname: typeof body.pageContext?.pathname === 'string' ? body.pageContext.pathname.slice(0, 160) : '/',
      focusedMac:
        typeof body.pageContext?.focusedMac === 'string'
          ? body.pageContext.focusedMac.slice(0, 32)
          : null,
    },
  });

  return NextResponse.json({ ok: true, ...turn });
}
