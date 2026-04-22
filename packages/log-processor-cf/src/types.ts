/**
 * Zajel Log Processor Worker - Type Definitions
 *
 * Types for the automated error pattern analysis pipeline
 * that runs on a cron trigger every 15 minutes.
 */

/**
 * Environment bindings for the Log Processor Worker.
 */
export interface Env {
  /** Shared D1 database (zajel-diagnostics) */
  DB: D1Database;
  /** R2 bucket for fetching sample diagnostic reports */
  REPORTS_BUCKET: R2Bucket;
  /** Workers AI binding (CF built-in type) */
  AI: Ai;
  /** GitHub Personal Access Token (secret) */
  GITHUB_TOKEN: string;
  /** GitHub repository in "owner/repo" format */
  GITHUB_REPO: string;
  /** Environment name (production, qa) */
  ENVIRONMENT?: string;
}

/**
 * A cluster of related errors sharing the same error_signature.
 * Aggregated from the error_aggregates table.
 */
export interface ErrorCluster {
  errorSignature: string;
  category: string;
  totalCount: number;
  versions: string[];
  platforms: string[];
  sampleMessages: string[];
  sampleStackTraces: string[];
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
  errorsProcessed: number;
  issuesCreated: number;
  issuesUpdated: number;
  aiCallsMade: number;
  aiTokensUsed: number;
  status: 'success' | 'partial' | 'failed';
}

/**
 * Result of a deduplication check.
 */
export interface DedupResult {
  isDuplicate: boolean;
  existingIssueNumber?: number;
  existingStatus?: string;
}

/**
 * Result of creating a GitHub issue.
 */
export interface GitHubIssueResult {
  issueNumber: number;
  issueUrl: string;
}

/** Valid severity levels for AI analysis */
export const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof VALID_SEVERITIES)[number];

/** Valid component labels for AI analysis */
export const VALID_COMPONENTS = [
  'crypto', 'network', 'ui', 'storage', 'protocol',
  'signaling', 'relay', 'webrtc', 'other',
] as const;
export type Component = (typeof VALID_COMPONENTS)[number];

/** Valid affected users estimate values */
export const VALID_AFFECTED_ESTIMATES = ['few', 'some', 'many', 'most'] as const;
export type AffectedUsersEstimate = (typeof VALID_AFFECTED_ESTIMATES)[number];

/** Minimum error count threshold to process a cluster */
export const ERROR_THRESHOLD = 5;

/** Maximum clusters to process per cron run */
export const MAX_CLUSTERS_PER_RUN = 20;

/** Maximum new GitHub issues to create per cron run */
export const MAX_NEW_ISSUES_PER_RUN = 10;

/** Default fallback time window (15 minutes in ms) */
export const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000;

/** Reopen threshold: reopen a closed issue if this many new occurrences */
export const REOPEN_THRESHOLD = 10;

/** Workers AI model identifier */
export const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

/** Fallback AI model identifier */
export const FALLBACK_AI_MODEL = '@cf/mistral/mistral-7b-instruct-v0.1';

/** Maximum retry count for pending GitHub issues before marking as failed */
export const MAX_RETRY_COUNT = 3;

/**
 * A log entry from server_logs or app_logs.
 */
export interface LogEntry {
  timestamp: number;
  severity: string;
  category: string;
  message: string;
}

/**
 * Related logs from server_logs and app_logs tables.
 */
export interface RelatedLogs {
  serverLogs: LogEntry[];
  appLogs: LogEntry[];
}

/** Minimum occurrences for a log message pattern to become a cluster */
export const LOG_CLUSTER_THRESHOLD = 5;
