import ky from "ky";
import { DEFAULT_RETRY_COUNT } from "./config.ts";

/**
 * Shared ky instance with default retry configuration.
 * ky automatically retries on network errors and 408/413/429/500/502/503/504.
 */
export const http = ky.create({
  retry: {
    limit: DEFAULT_RETRY_COUNT,
    backoffLimit: 10_000,
  },
  timeout: 60_000,
  hooks: {
    beforeRetry: [
      ({ retryCount, error }) => {
        console.warn(`  Retry ${retryCount}/${DEFAULT_RETRY_COUNT}: ${error.message}`);
      },
    ],
  },
});

/**
 * ky instance for large file downloads with longer timeout and no response timeout.
 */
export const httpDownload = http.extend({
  timeout: false,
});
