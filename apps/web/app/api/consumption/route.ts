import { NextResponse } from 'next/server';
import { getConsumption } from '../../../lib/queries';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ devices: getConsumption() });
}
