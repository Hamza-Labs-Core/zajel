/**
 * Workers AI integration for error pattern analysis.
 *
 * Calls @cf/meta/llama-3.1-8b-instruct to analyze error clusters and
 * produce structured JSON with severity, component, description, and
 * suggested fixes. Gracefully degrades on failure (returns null).
 */

import type { AiAnalysis, Env, ErrorCluster } from './types.js';
import { AI_MODEL } from './types.js';

/**
 * Build the AI prompt for a given error cluster.
 */
export function buildPrompt(cluster: ErrorCluster): string {
  return `You are a software engineer analyzing crash reports for a P2P encrypted messaging app called Zajel. The app uses Flutter, WebRTC, X25519+ChaCha20-Poly1305 encryption, and connects to VPS relay servers.

Analyze these error reports and provide a structured analysis:

Error Signature: ${cluster.errorSignature}
Category: ${cluster.category}
Total Occurrences: ${cluster.totalCount} in the last processing window
Affected Versions: ${cluster.appVersions}
Affected Platforms: ${cluster.platforms}

Sample Error Messages:
${cluster.sampleMessage}

Sample Stack Traces:
${cluster.sampleStackTrace}

Provide your analysis in this exact JSON format (no markdown wrapping, just raw JSON):
{
  "title": "Brief issue title (max 80 chars)",
  "severity": "critical|high|medium|low",
  "component": "crypto|network|ui|storage|protocol|signaling|relay|webrtc|other",
  "description": "2-3 paragraph description of the likely root cause",
  "reproduction_hints": "How a developer might reproduce this",
  "suggested_fix": "Brief suggestion for fixing",
  "is_regression": true or false,
  "affected_users_estimate": "few|some|many|most"
}`;
}

/**
 * Parse AI response text into a structured AiAnalysis.
 * Handles both raw JSON and markdown-wrapped JSON (```json ... ```).
 *
 * @returns Parsed AiAnalysis or null if parsing fails.
 */
export function parseAiResponse(responseText: string): AiAnalysis | null {
  try {
    let jsonStr = responseText.trim();

    // Strip markdown code fence if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch?.[1]) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed: Record<string, unknown> = JSON.parse(jsonStr);

    // Validate required fields
    const title = typeof parsed['title'] === 'string' ? parsed['title'] : null;
    const severity = parsed['severity'];
    const component = typeof parsed['component'] === 'string' ? parsed['component'] : null;
    const description = typeof parsed['description'] === 'string' ? parsed['description'] : null;
    const reproductionHints =
      typeof parsed['reproduction_hints'] === 'string' ? parsed['reproduction_hints'] : '';
    const suggestedFix =
      typeof parsed['suggested_fix'] === 'string' ? parsed['suggested_fix'] : '';
    const isRegression =
      typeof parsed['is_regression'] === 'boolean' ? parsed['is_regression'] : false;
    const affectedUsersEstimate = parsed['affected_users_estimate'];

    if (!title || !severity || !component || !description) {
      return null;
    }

    const validSeverities = ['critical', 'high', 'medium', 'low'] as const;
    if (!validSeverities.includes(severity as typeof validSeverities[number])) {
      return null;
    }

    const validEstimates = ['few', 'some', 'many', 'most'] as const;
    const estimate = validEstimates.includes(
      affectedUsersEstimate as typeof validEstimates[number],
    )
      ? (affectedUsersEstimate as AiAnalysis['affectedUsersEstimate'])
      : 'few';

    return {
      title,
      severity: severity as AiAnalysis['severity'],
      component,
      description,
      reproductionHints,
      suggestedFix,
      isRegression,
      affectedUsersEstimate: estimate,
    };
  } catch {
    return null;
  }
}

/**
 * Analyze an error cluster using Workers AI.
 *
 * @returns AiAnalysis on success, null on failure (graceful degradation).
 */
export async function analyzeErrorCluster(
  env: Env,
  cluster: ErrorCluster,
): Promise<{ analysis: AiAnalysis | null; tokensUsed: number }> {
  try {
    const prompt = buildPrompt(cluster);

    const response = await env.AI.run(AI_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
    });

    const responseText: string =
      typeof response === 'string'
        ? response
        : typeof response?.response === 'string'
          ? response.response
          : '';

    if (!responseText) {
      return { analysis: null, tokensUsed: 0 };
    }

    // Estimate tokens used (rough approximation)
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(responseText.length / 4);
    const tokensUsed = inputTokens + outputTokens;

    const analysis = parseAiResponse(responseText);
    return { analysis, tokensUsed };
  } catch {
    return { analysis: null, tokensUsed: 0 };
  }
}
