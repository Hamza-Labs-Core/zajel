/**
 * Zajel Log Processor Worker - Entry Point
 *
 * Cron-triggered worker (every 15 minutes) that reads error data
 * from the shared D1 database, analyzes error patterns using
 * Workers AI, creates GitHub issues, and avoids duplicates.
 *
 * User Stories:
 * - US-6.1: Automated Error Pattern Analysis
 * - US-6.2: Automated GitHub Issue Creation
 * - US-6.4: Deduplication
 */

import type { Env } from './types.js';
import { runProcessingPipeline, recordProcessingRun } from './pipeline.js';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const runStart = Date.now();

    try {
      const result = await runProcessingPipeline(env);

      console.log(
        `Log processing complete: processed=${result.errorsProcessed}, ` +
          `created=${result.issuesCreated}, updated=${result.issuesUpdated}, ` +
          `ai_calls=${result.aiCallsMade}, tokens=${result.aiTokensUsed}, ` +
          `status=${result.status}`,
      );

      await recordProcessingRun(env, runStart, result);
    } catch (error) {
      console.error('Log processing pipeline failed:', error);

      try {
        await recordProcessingRun(env, runStart, {
          errorsProcessed: 0,
          issuesCreated: 0,
          issuesUpdated: 0,
          aiCallsMade: 0,
          aiTokensUsed: 0,
          status: 'failed',
        });
      } catch (recordError) {
        console.error('Failed to record processing run failure:', recordError);
      }
    }
  },
};
