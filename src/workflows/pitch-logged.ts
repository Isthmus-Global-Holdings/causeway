// An Upwork pitch, logged as a deal: one per job, in the Sales Pipeline's
// first stage, marked deal_source = Upwork. Safe to repeat without a D1 row:
// upwork_job_id is a unique-value property in HubSpot, so the job's deal is
// read by it first, and HubSpot itself refuses a second one when two presses
// race. A repeat never writes the deal back, so a deal moved along the
// pipeline stays where the rep put it.

import { HubSpotApiError, type HubSpot, type HubSpotObject } from '../lib/hubspot';
import { pitchDealName, pitchDescription, type Pitch } from '../lib/upwork';

export const PITCH_PIPELINE = 'default'; // "Sales Pipeline"
export const PITCH_STAGE = 'appointmentscheduled'; // its first stage
export const JOB_ID_PROPERTY = 'upwork_job_id';

export interface PitchResult {
  dealId: string;
  created: boolean; // false: the job already had its deal
}

type Deals = Pick<HubSpot, 'getByUniqueValue' | 'createDeal'>;

function existingDeal(hs: Deals, jobId: string): Promise<HubSpotObject | null> {
  return hs.getByUniqueValue('deals', JOB_ID_PROPERTY, jobId, ['dealname']);
}

// `pitchedOn` is the rep's local date, for the deal's description.
export async function logPitch(hs: Deals, pitch: Pitch, pitchedOn: string): Promise<PitchResult> {
  const existing = await existingDeal(hs, pitch.jobId);
  if (existing) return { dealId: existing.id, created: false };
  try {
    const dealId = await hs.createDeal({
      dealname: pitchDealName(pitch),
      pipeline: PITCH_PIPELINE,
      dealstage: PITCH_STAGE,
      deal_source: 'Upwork',
      [JOB_ID_PROPERTY]: pitch.jobId,
      description: pitchDescription(pitch, pitchedOn),
    });
    return { dealId, created: true };
  } catch (err) {
    // Another press made the job's deal since the read: HubSpot refuses the
    // duplicate value (400 or 409). Answer with that deal.
    if (err instanceof HubSpotApiError && (err.status === 400 || err.status === 409)) {
      const raced = await existingDeal(hs, pitch.jobId);
      if (raced) return { dealId: raced.id, created: false };
    }
    throw err;
  }
}
