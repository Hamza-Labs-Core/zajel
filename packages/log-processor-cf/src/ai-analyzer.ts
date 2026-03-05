/**
 * Workers AI integration for error pattern analysis.
 *
 * Uses Cloudflare Workers AI (Llama 3.1 8B) to analyze error clusters
 * and produce structured analysis for GitHub issue creation.
 */

import type { Env, ErrorCluster, AiAnalysis } from './types.js';
import {
  AI_MODEL,
  VALID_SEVERITIES,
  VALID_COMPONENTS,
  VALID_AFFECTED_ESTIMATES,
} from './types.js';

/**
 * Build the AI prompt for analyzing an error cluster.
 */
export function buildPrompt(cluster: ErrorCluster, timeWindow: string): string {
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
 * Analyze an error cluster using Workers AI.
 *
 * Returns an AiAnalysis object, or null if the AI call fails or
 * returns malformed output (graceful degradation).
 */
export async function analyzeWithAi(
  env: Env,
  cluster: ErrorCluster,
  timeWindow: string,
): Promise<{ analysis: AiAnalysis | null; tokensUsed: number }> {
  const prompt = buildPrompt(cluster, timeWindow);

  try {
    const response = await env.AI.run(AI_MODEL as BaseAiTextGenerationModels, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
    });

    // Workers AI returns either a string or an object with 'response' field
    let responseText: string;
    let tokensUsed = 0;

    if (typeof response === 'string') {
      responseText = response;
    } else if (
      typeof response === 'object' &&
      response !== null &&
      'response' in response &&
      typeof response.response === 'string'
    ) {
      responseText = response.response;
      // Extract token usage from metadata if available
      if ('usage' in response && typeof response.usage === 'object' && response.usage !== null) {
        const usage = response.usage as Record<string, unknown>;
        const inputTokens =
          typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0;
        const outputTokens =
          typeof usage['completion_tokens'] === 'number'
            ? usage['completion_tokens']
            : 0;
        tokensUsed = inputTokens + outputTokens;
      }
    } else {
      console.error('Unexpected AI response format:', typeof response);
      return { analysis: null, tokensUsed: 0 };
    }

    const analysis = parseAiResponse(responseText);
    return { analysis, tokensUsed };
  } catch (error) {
    console.error('Workers AI call failed:', error);
    return { analysis: null, tokensUsed: 0 };
  }
}
