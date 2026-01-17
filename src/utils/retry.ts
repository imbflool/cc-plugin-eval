/**
 * Retry utility with exponential backoff.
 * Handles transient API errors gracefully.
 *
 * Uses typed Anthropic SDK error classes for accurate error detection:
 * - Transient errors (will retry): RateLimitError, InternalServerError,
 *   APIConnectionError, APIConnectionTimeoutError
 * - Non-transient errors (will not retry): AuthenticationError,
 *   BadRequestError, PermissionDeniedError, NotFoundError
 */

import Anthropic from "@anthropic-ai/sdk";

import { DEFAULT_TUNING } from "../config/defaults.js";

import { logger } from "./logging.js";

import type { TuningConfig } from "../types/index.js";

/**
 * Retry options.
 */
export interface RetryOptions {
  /** Maximum number of retries */
  maxRetries: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** Jitter factor (0-1) to add randomness */
  jitterFactor: number;
  /** Function to determine if error is retryable */
  isRetryable?: (error: unknown) => boolean;
  /** Callback on retry */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Default retry callback that logs errors with request IDs.
 *
 * @param error - The error that caused the retry
 * @param attempt - The retry attempt number (1-indexed)
 * @param delayMs - The delay before the next retry in milliseconds
 */
function defaultOnRetry(
  error: unknown,
  attempt: number,
  delayMs: number,
): void {
  const formattedError = formatErrorWithRequestId(error);
  logger.warn(
    `Retry attempt ${String(attempt)}: ${formattedError} (waiting ${String(delayMs)}ms)`,
  );
}

/**
 * Default retry options.
 * Values are sourced from DEFAULT_TUNING for centralized configuration.
 * Includes default logging callback that captures request IDs for debugging.
 */
export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: DEFAULT_TUNING.retry.max_retries,
  initialDelayMs: DEFAULT_TUNING.timeouts.retry_initial_ms,
  maxDelayMs: DEFAULT_TUNING.timeouts.retry_max_ms,
  backoffMultiplier: DEFAULT_TUNING.retry.backoff_multiplier,
  jitterFactor: DEFAULT_TUNING.retry.jitter_factor,
  isRetryable: isTransientError,
  onRetry: defaultOnRetry,
};

/**
 * Create retry options from tuning configuration.
 *
 * @param tuning - Tuning configuration
 * @returns Retry options based on tuning config
 */
export function createRetryOptionsFromTuning(
  tuning: TuningConfig,
): RetryOptions {
  return {
    maxRetries: tuning.retry.max_retries,
    initialDelayMs: tuning.timeouts.retry_initial_ms,
    maxDelayMs: tuning.timeouts.retry_max_ms,
    backoffMultiplier: tuning.retry.backoff_multiplier,
    jitterFactor: tuning.retry.jitter_factor,
    isRetryable: isTransientError,
    onRetry: defaultOnRetry,
  };
}

/**
 * Check if an SDK error is a transient error type.
 *
 * @param error - The error to check
 * @returns true if transient, false if non-transient, undefined if not an SDK error
 */
function checkSdkErrorType(error: unknown): boolean | undefined {
  // Transient SDK errors - should retry
  if (error instanceof Anthropic.RateLimitError) {
    return true;
  }
  if (error instanceof Anthropic.InternalServerError) {
    return true;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return true;
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return true;
  }

  // Non-transient SDK errors - should NOT retry
  if (error instanceof Anthropic.AuthenticationError) {
    return false;
  }
  if (error instanceof Anthropic.BadRequestError) {
    return false;
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return false;
  }
  if (error instanceof Anthropic.NotFoundError) {
    return false;
  }

  // For other APIError subtypes, check status code
  if (error instanceof Anthropic.APIError) {
    // APIError.status may be number | undefined, validate at runtime
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- validated below
    const status = error.status;
    if (typeof status === "number") {
      return status === 429 || (status >= 500 && status < 600);
    }
    return false;
  }

  return undefined; // Not an SDK error
}

/**
 * Check if an error message indicates a transient error.
 *
 * @param message - The lowercase error message
 * @returns true if transient
 */
function isTransientErrorMessage(message: string): boolean {
  // Rate limiting
  if (message.includes("rate limit") || message.includes("too many requests")) {
    return true;
  }

  // Server errors (5xx)
  if (
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  ) {
    return true;
  }

  // Network errors
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up")
  ) {
    return true;
  }

  // Anthropic-specific transient errors
  if (
    message.includes("overloaded") ||
    message.includes("temporarily unavailable")
  ) {
    return true;
  }

  return false;
}

/**
 * Determine if an error is transient and retryable.
 *
 * Uses Anthropic SDK typed error classes for accurate detection:
 * - Transient (will retry): RateLimitError, InternalServerError,
 *   APIConnectionError, APIConnectionTimeoutError
 * - Non-transient (will not retry): AuthenticationError, BadRequestError,
 *   PermissionDeniedError, NotFoundError
 *
 * Falls back to message-based detection for non-SDK errors.
 *
 * @param error - The error to check
 * @returns True if the error is transient
 */
export function isTransientError(error: unknown): boolean {
  // Check Anthropic SDK typed errors first (most reliable)
  const sdkResult = checkSdkErrorType(error);
  if (sdkResult !== undefined) {
    return sdkResult;
  }

  // Fallback to message-based detection for non-SDK errors
  if (error instanceof Error) {
    if (isTransientErrorMessage(error.message.toLowerCase())) {
      return true;
    }
  }

  // Check for status code in error object (fallback for plain objects)
  // Validate error is an object before accessing properties
  if (typeof error === "object" && error !== null) {
    const errorRecord = error as Record<string, unknown>;
    const status = errorRecord["status"] ?? errorRecord["statusCode"];
    if (typeof status === "number") {
      return status === 429 || (status >= 500 && status < 600);
    }
  }

  return false;
}

/**
 * Headers object type - supports both plain objects and Headers-like objects.
 */
type HeadersObject =
  | Record<string, string>
  | { get(name: string): string | null };

/**
 * Error with optional headers property.
 */
interface ErrorWithHeaders {
  headers?: HeadersObject;
}

/**
 * Extract retry-after delay from error headers.
 *
 * Checks headers in order of preference:
 * 1. retry-after-ms - Anthropic's preferred header (milliseconds, 0-60000ms)
 * 2. retry-after - RFC standard (seconds)
 *
 * Handles both plain object headers and Headers-like objects (from Anthropic SDK).
 *
 * @param error - The error that may contain retry-after header
 * @returns Delay in milliseconds, or null if not present/invalid
 */
export function extractRetryAfter(error: unknown): number | null {
  const errorWithHeaders = error as ErrorWithHeaders;

  if (!errorWithHeaders.headers) {
    return null;
  }

  const headers = errorWithHeaders.headers;

  // Check retry-after-ms first (Anthropic's preferred header, milliseconds)
  let retryAfterMsValue: string | null | undefined;
  if (typeof headers.get === "function") {
    retryAfterMsValue = headers.get("retry-after-ms");
  } else {
    const plainHeaders = headers as Record<string, string>;
    retryAfterMsValue = plainHeaders["retry-after-ms"];
  }

  if (retryAfterMsValue) {
    const ms = parseInt(retryAfterMsValue, 10);
    // Validate range: 0-60000ms (per Anthropic SDK)
    if (!isNaN(ms) && ms >= 0 && ms <= 60000) {
      return ms; // Already in milliseconds
    }
  }

  // Fall back to retry-after (seconds)
  let retryAfterValue: string | null | undefined;
  if (typeof headers.get === "function") {
    retryAfterValue = headers.get("retry-after");
  } else {
    const plainHeaders = headers as Record<string, string>;
    retryAfterValue = plainHeaders["retry-after"];
  }

  if (!retryAfterValue) {
    return null;
  }

  const seconds = parseInt(retryAfterValue, 10);
  if (isNaN(seconds)) {
    return null;
  }

  return seconds * 1000; // Convert to milliseconds
}

/**
 * Calculate delay for a retry attempt with exponential backoff and jitter.
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param options - Retry options
 * @returns Delay in milliseconds
 */
export function calculateDelay(attempt: number, options: RetryOptions): number {
  // Exponential backoff
  const exponentialDelay =
    options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);

  // Add jitter
  const jitter = cappedDelay * options.jitterFactor * Math.random();

  return Math.floor(cappedDelay + jitter);
}

/**
 * Sleep for a given duration.
 *
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after the delay
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic.
 *
 * @param fn - Function to execute
 * @param options - Retry options (optional)
 * @returns Result of the function
 * @throws Last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const shouldRetry =
        attempt < opts.maxRetries &&
        (opts.isRetryable?.(error) ?? isTransientError(error));

      if (!shouldRetry) {
        throw error;
      }

      // Calculate delay, respecting retry-after header if present
      let delayMs = calculateDelay(attempt, opts);
      const retryAfterMs = extractRetryAfter(error);
      if (retryAfterMs !== null) {
        delayMs = Math.max(delayMs, retryAfterMs);
      }

      // Call retry callback
      opts.onRetry?.(error, attempt + 1, delayMs);

      // Wait before retrying
      await sleep(delayMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

/**
 * Create a retry wrapper with preset options.
 *
 * @param options - Retry options
 * @returns Function that wraps another function with retry logic
 */
export function createRetryWrapper(
  options: Partial<RetryOptions> = {},
): <T>(fn: () => Promise<T>) => Promise<T> {
  return async <T>(fn: () => Promise<T>): Promise<T> => withRetry(fn, options);
}

/**
 * Error with optional requestID property.
 */
interface ErrorWithRequestId {
  requestID?: string;
  headers?: HeadersObject;
}

/**
 * Extract request ID from an Anthropic SDK error.
 *
 * Request IDs are critical for Anthropic support tickets and debugging.
 * They can be found in:
 * - error.requestID (direct property on APIError)
 * - error.headers.get("request-id") (from HTTP response headers)
 *
 * @param error - The error to extract request ID from
 * @returns The request ID string, or null if not found
 */
export function extractRequestId(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null;
  }

  if (typeof error !== "object") {
    return null;
  }

  const errorObj = error as ErrorWithRequestId;

  // Check for direct requestID property (Anthropic SDK APIError)
  if (typeof errorObj.requestID === "string" && errorObj.requestID.length > 0) {
    return errorObj.requestID;
  }

  // Check for request-id in headers
  if (errorObj.headers) {
    // Handle Headers-like object (Anthropic SDK uses this)
    if (typeof errorObj.headers.get === "function") {
      const requestId = errorObj.headers.get("request-id");
      if (typeof requestId === "string" && requestId.length > 0) {
        return requestId;
      }
    } else {
      // Handle plain object headers
      const plainHeaders = errorObj.headers as Record<string, string>;
      const requestId = plainHeaders["request-id"];
      if (typeof requestId === "string" && requestId.length > 0) {
        return requestId;
      }
    }
  }

  return null;
}

/**
 * Format an error message with request ID if available.
 *
 * For Anthropic SDK APIError instances, includes:
 * - The error message
 * - HTTP status code (if available)
 * - Request ID (if available)
 *
 * @param error - The error to format
 * @returns Formatted error message string
 */
export function formatErrorWithRequestId(error: unknown): string {
  if (error === null) {
    return "null";
  }
  if (error === undefined) {
    return "undefined";
  }

  // Handle non-Error values
  if (typeof error === "string") {
    return error;
  }

  if (!(error instanceof Error)) {
    // For objects, try to get a meaningful string representation
    if (typeof error === "object") {
      const objWithMessage = error as { message?: unknown };
      if (typeof objWithMessage.message === "string") {
        return objWithMessage.message;
      }
      return JSON.stringify(error);
    }
    // At this point, error is a primitive (number, boolean, bigint, symbol)
    // String() is safe for all these types
    return String(error as string | number | boolean | bigint | symbol);
  }

  // Extract components
  const message = error.message;
  const requestId = extractRequestId(error);

  // Check if it's an APIError with status
  const apiError = error as { status?: number };
  const status = typeof apiError.status === "number" ? apiError.status : null;

  // Build formatted message
  if (status !== null && requestId !== null) {
    return `${message} (status: ${String(status)}) [request: ${requestId}]`;
  } else if (requestId !== null) {
    return `${message} [request: ${requestId}]`;
  } else if (status !== null) {
    return `${message} (status: ${String(status)})`;
  }

  return message;
}
