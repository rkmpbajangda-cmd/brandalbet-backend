import { finalizeRewardWeekBatch, previousRewardWeekKey } from '../../src/rewards/service.js';

// Scheduled only from Netlify. The operation is intentionally idempotent:
// repeated invocations advance the same closed-week cursor and cannot double-pay.
export async function handler() {
  try {
    const weekKey = previousRewardWeekKey();
    const result = await finalizeRewardWeekBatch(weekKey, {
      batchSize: 100,
      concurrency: 6,
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, ...result }),
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'weekly_rewards_job_failed',
      code: typeof error?.code === 'string' ? error.code : 'internal_error',
    }));
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'weekly_rewards_job_failed' }),
    };
  }
}
