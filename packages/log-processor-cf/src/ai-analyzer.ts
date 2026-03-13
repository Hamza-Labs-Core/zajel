/**
 * Workers AI integration for error pattern analysis.
 *
 * Uses Cloudflare Workers AI (Llama 3.1 8B) to analyze error clusters
 * and produce structured analysis for GitHub issue creation.
 */

import type { Env, ErrorCluster, AiAnalysis } from './types.js';
import type { RegressionInfo } from './regression.js';
import {
  AI_MODEL,
  FALLBACK_AI_MODEL,
  VALID_SEVERITIES,
  VALID_COMPONENTS,
  VALID_AFFECTED_ESTIMATES,
} from './types.js';

/**
 * Build the AI prompt for analyzing an error cluster.
 * Optionally includes regression detection context.
 */
export function buildPrompt(cluster: ErrorCluster, timeWindow: string, regression?: RegressionInfo): string {
  const sampleMessages = cluster.sampleMessages
    .map((msg, i) => `${i + 1}. ${msg}`)
    .join('\n');
  const sampleStackTraces = cluster.sampleStackTraces
    .filter((st) => st.length > 0)
    .map((st, i) => `--- Stack Trace ${i + 1} ---\n${st}`)
    .join('\n\n');

  return `You are a software engineer analyzing crash reports for a P2P encrypted
messaging app called Zajel. The app uses Flutter, WebRTC,
X25519+ChaCha20-Poly1305 encryption, and connects to VPS relay servers.

Analyze these error reports and provide a structured analysis:

Error Signature: ${cluster.errorSignature}
Category: ${cluster.category}
Total Occurrences: ${cluster.totalCount} in last ${timeWindow}
Affected Versions: ${cluster.versions.join(', ')}
Affected Platforms: ${cluster.platforms.join(', ')}

Sample Error Messages:
${sampleMessages}

Sample Stack Traces:
${sampleStackTraces || 'No stack traces available'}
${regression ? `
REGRESSION DETECTED:
- Current error rate: ${regression.currentRate} errors/hour
- Baseline rate (24h avg): ${regression.baselineRate.toFixed(2)} errors/hour
- Rate multiplier: ${regression.multiplier}x baseline
- New in version ${regression.latestVersion}: ${regression.isNewInVersion ? 'YES' : 'NO'}
- This error is flagged as a regression. Set is_regression to true.
` : ''}
Provide your analysis in this exact JSON format:
{
  "title": "Brief issue title (max 80 chars)",
  "severity": "critical|high|medium|low",
  "component": "crypto|network|ui|storage|protocol|signaling|relay|webrtc|other",
  "description": "2-3 paragraph description of the likely root cause",
  "reproduction_hints": "How a developer might reproduce this",
  "suggested_fix": "Brief suggestion for fixing",
  "is_regression": true|false,
  "affected_users_estimate": "few|some|many|most"
}`;
}

/**
 * Parse and validate the AI response JSON into an AiAnalysis object.
 * Returns null if the response cannot be parsed or is invalid.
 */
export function parseAiResponse(rawText: string): AiAnalysis | null {
  try {
    // Try to extract JSON from the response (AI may wrap it in markdown code blocks)
    let jsonStr = rawText.trim();

    // Strip markdown code block wrappers if present
    const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonBlockMatch?.[1]) {
      jsonStr = jsonBlockMatch[1].trim();
    }

    const parsed: unknown = JSON.parse(jsonStr);

    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    // Validate required fields with correct types
    if (typeof obj['title'] !== 'string' || obj['title'].length === 0) {
      return null;
    }

    const severity = obj['severity'];
    if (
      typeof severity !== 'string' ||
      !VALID_SEVERITIES.includes(severity as typeof VALID_SEVERITIES[number])
    ) {
      return null;
    }

    const component = obj['component'];
    if (
      typeof component !== 'string' ||
      !VALID_COMPONENTS.includes(component as typeof VALID_COMPONENTS[number])
    ) {
      return null;
    }

    if (typeof obj['description'] !== 'string') return null;
    if (typeof obj['reproduction_hints'] !== 'string') return null;
    if (typeof obj['suggested_fix'] !== 'string') return null;
    if (typeof obj['is_regression'] !== 'boolean') return null;

    const estimate = obj['affected_users_estimate'];
    if (
      typeof estimate !== 'string' ||
      !VALID_AFFECTED_ESTIMATES.includes(
        estimate as typeof VALID_AFFECTED_ESTIMATES[number],
      )
    ) {
      return null;
    }

    // Truncate title to 80 chars
    const title =
      (obj['title'] as string).length > 80
        ? (obj['title'] as string).substring(0, 77) + '...'
        : (obj['title'] as string);

    return {
      title,
      severity: severity as AiAnalysis['severity'],
      component: component as string,
      description: obj['description'] as string,
      reproductionHints: obj['reproduction_hints'] as string,
      suggestedFix: obj['suggested_fix'] as string,
      isRegression: obj['is_regression'] as boolean,
      affectedUsersEstimate: estimate as AiAnalysis['affectedUsersEstimate'],
    };
  } catch {
    return null;
  }
}

/**
 * Extract response text and token usage from an AI response.
 * Returns null if the response format is unexpected.
 */
function extractAiResponse(
  response: unknown,
): { responseText: string; tokensUsed: number } | null {
  let responseText: string;
  let tokensUsed = 0;

  if (typeof response === 'string') {
    responseText = response;
  } else if (
    typeof response === 'object' &&
    response !== null &&
    'response' in response &&
    typeof (response as Record<string, unknown>).response === 'string'
  ) {
    responseText = (response as Record<string, unknown>).response as string;
    // Extract token usage from metadata if available
    if ('usage' in response && typeof (response as Record<string, unknown>).usage === 'object' && (response as Record<string, unknown>).usage !== null) {
      const usage = (response as Record<string, unknown>).usage as Record<string, unknown>;
      const inputTokens =
        typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0;
      const outputTokens =
        typeof usage['completion_tokens'] === 'number'
          ? usage['completion_tokens']
          : 0;
      tokensUsed = inputTokens + outputTokens;
    }
  } else {
    return null;
  }

  // Treat empty response text as a failure
  if (responseText.trim().length === 0) {
    return null;
  }

  return { responseText, tokensUsed };
}

/**
 * Analyze an error cluster using Workers AI.
 *
 * Returns an AiAnalysis object, or null if the AI call fails or
 * returns malformed output (graceful degradation).
 *
 * If the primary model fails or returns empty, retries once with
 * the fallback model.
 */
export async function analyzeWithAi(
  env: Env,
  cluster: ErrorCluster,
  timeWindow: string,
  regression?: RegressionInfo,
): Promise<{ analysis: AiAnalysis | null; tokensUsed: number; modelUsed: string }> {
  const prompt = buildPrompt(cluster, timeWindow, regression);

  // Try primary model first
  const primaryResult = await tryAiModel(env, AI_MODEL, prompt);
  if (primaryResult && primaryResult.analysis) {
    return { ...primaryResult, modelUsed: AI_MODEL };
  }

  // Primary failed or returned empty/unparseable — try fallback
  console.log(`Primary AI model failed, retrying with fallback model: ${FALLBACK_AI_MODEL}`);
  const fallbackResult = await tryAiModel(env, FALLBACK_AI_MODEL, prompt);
  if (fallbackResult) {
    return { ...fallbackResult, modelUsed: FALLBACK_AI_MODEL };
  }

  // Both models failed
  return {
    analysis: null,
    tokensUsed: primaryResult?.tokensUsed ?? 0,
    modelUsed: AI_MODEL,
  };
}

/**
 * Attempt to run a single AI model and parse the response.
 * Returns null if the model call throws.
 */
async function tryAiModel(
  env: Env,
  model: string,
  prompt: string,
): Promise<{ analysis: AiAnalysis | null; tokensUsed: number } | null> {
  try {
    const response = await env.AI.run(model as BaseAiTextGenerationModels, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
    });

    const extracted = extractAiResponse(response);
    if (!extracted) {
      console.error(`Unexpected AI response format from ${model}:`, typeof response);
      return { analysis: null, tokensUsed: 0 };
    }

    const analysis = parseAiResponse(extracted.responseText);
    return { analysis, tokensUsed: extracted.tokensUsed };
  } catch (error) {
    console.error(`Workers AI call failed (${model}):`, error);
    return null;
  }
}
