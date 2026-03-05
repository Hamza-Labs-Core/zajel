/**
 * Zajel Log Processor Worker - Entry Point
 *
 * Cloudflare Worker triggered by a cron schedule (every 15 minutes).
 * Reads error data from the shared D1 database, analyzes error patterns
 * using Workers AI, creates GitHub issues for significant errors, and
 * avoids duplicates via the issue_tracking table.
 *
 * Trigger: Cron (*/15 * * * *)
 */

import type { Env, ProcessingRunResult } from './types.js';
import { runProcessingPipeline, recordProcessingRun } from './pipeline.js';

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    let result: ProcessingRunResult | null = null;

    try {
      result = await runProcessingPipeline(env);

      console.log(
        `Processing complete: ${result.errorsProcessed} errors, ` +
          `${result.issuesCreated} created, ${result.issuesUpdated} updated, ` +
          `status=${result.status}`,
      );
    } catch (error) {
      const runEnd = Date.now();
      result = {
        runStart: runEnd,
        runEnd,
        errorsProcessed: 0,
        issuesCreated: 0,
        issuesUpdated: 0,
        aiCallsMade: 0,
        aiTokensUsed: 0,
        status: 'failed',
      };

      console.error('Processing pipeline failed:', error);
    }

    // Always record the run, even on failure
    try {
      await recordProcessingRun(env.DB, result);
    } catch {
      console.error('Failed to record processing run');
    }
  },
};
