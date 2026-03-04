/**
 * Zajel Log Processor Worker - Type Definitions
 *
 * Defines the environment bindings, data structures for error clusters,
 * AI analysis results, deduplication, and processing run tracking.
 */

/**
 * Environment bindings for the Log Processor Worker.
 */
export interface Env {
  /** D1 database shared with diagnostics-cf */
  DB: D1Database;
  /** R2 bucket for reading raw diagnostic reports */
  REPORTS_BUCKET: R2Bucket;
  /** Workers AI binding */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Workers AI Ai type varies across SDK versions
  AI: any;
  /** GitHub personal access token (secret) */
  GITHUB_TOKEN: string;
  /** GitHub repository in "owner/repo" format */
  GITHUB_REPO: string;
  /** Environment name (production, qa) */
  ENVIRONMENT?: string;
}

/**
 * An error cluster aggregated from error_aggregates in D1.
 * Represents a group of errors sharing the same signature.
 */
export interface ErrorCluster {
  errorSignature: string;
  category: string;
  totalCount: number;
  appVersions: string;
  platforms: string;
  sampleMessage: string;
  sampleStackTrace: string;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Structured analysis output from Workers AI.
 */
export interface AiAnalysis {
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  component: string;
  description: string;
  reproductionHints: string;
  suggestedFix: string;
  isRegression: boolean;
  affectedUsersEstimate: 'few' | 'some' | 'many' | 'most';
}

/**
 * Result of a single processing run.
 */
export interface ProcessingRunResult {
  runStart: number;
  runEnd: number;
  errorsProcessed: number;
  issuesCreated: number;
  issuesUpdated: number;
  aiCallsMade: number;
  aiTokensUsed: number;
  status: 'success' | 'partial' | 'failed';
}

/**
 * Result of deduplication check for an error signature.
 */
export interface DedupResult {
  isDuplicate: boolean;
  existingIssueNumber: number | null;
  existingIssueUrl: string | null;
  action: 'create' | 'update' | 'reopen' | 'skip';
  existingId: number | null;
}

/**
 * Result of a GitHub issue creation or update.
 */
export interface GitHubIssueResult {
  issueNumber: number;
  issueUrl: string;
  action: 'created' | 'updated' | 'reopened';
}

/**
 * Row from the issue_tracking table in D1.
 */
export interface IssueTrackingRow {
  id: number;
  error_signature: string;
  github_issue_number: number | null;
  github_issue_url: string | null;
  severity: string;
  component: string;
  status: string;
  ai_analysis: string | null;
  first_detected: number;
  last_detected: number;
  total_occurrences: number;
  created_at: number;
  updated_at: number;
}

/** Minimum occurrences threshold for processing an error cluster. */
export const ERROR_THRESHOLD = 5;

/** Maximum number of error clusters to process per cron run. */
export const MAX_CLUSTERS_PER_RUN = 20;

/** Maximum number of new GitHub issues to create per cron run. */
export const MAX_NEW_ISSUES_PER_RUN = 10;

/** Reopen threshold: if a closed issue has this many new occurrences, reopen it. */
export const REOPEN_THRESHOLD = 10;

/** Workers AI model for analysis. */
export const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
