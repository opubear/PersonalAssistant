import type { ObservationInput } from '@qiyi/contracts';
import type { AssistantClient } from '@qiyi/client';

export async function uploadObservations(
  client: AssistantClient,
  sourceId: string,
  observations: ObservationInput[],
) {
  const total = { created: 0, updated: 0, skipped: 0 };
  for (let offset = 0; offset < observations.length; offset += 25) {
    const result = await client.call('observations.import', {
      sourceId,
      observations: observations.slice(offset, offset + 25),
    });
    total.created += result.created;
    total.updated += result.updated;
    total.skipped += result.skipped;
  }
  return total;
}
