import { NextResponse } from 'next/server';
import { getOutages } from '../../../lib/queries';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ outages: getOutages(200) });
}
