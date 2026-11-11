import { enrolClosedResponse } from '../../../../../lib/shared-passkey';

export const dynamic = 'force-dynamic';

/** Enrolment is closed for good: one shared Apple passkey opens every tv-eg.com panel. */
export async function POST() {
  return enrolClosedResponse();
}

export async function GET() {
  return enrolClosedResponse();
}
