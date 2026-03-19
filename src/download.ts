import { ProgressBar } from "@std/cli/unstable-progress-bar";
import type { ProgressBarFormatter } from "@std/cli/unstable-progress-bar";
import { ensureDir } from "@std/fs/ensure-dir";
import { dirname } from "@std/path";
import { httpDownload } from "./http.ts";
import { DEFAULT_RETRY_COUNT } from "./config.ts";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** CI progress log interval */
const CI_INTERVAL_MS = 5_000;

/** Metadata for a partial download (stored alongside .partial file) */
interface DownloadMeta {
  url: string;
  totalSize: number;
}

async function sha256Hex(filePath: string): Promise<string> {
  const data = await Deno.readFile(filePath);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Read the resume point from a .partial file + .partial.meta.
 * Returns 0 if no valid partial download exists for this URL.
 */
async function getResumePoint(
  partialPath: string,
  metaPath: string,
  url: string,
): Promise<number> {
  try {
    const meta: DownloadMeta = JSON.parse(await Deno.readTextFile(metaPath));
    if (meta.url !== url) return 0;
    const stat = await Deno.stat(partialPath);
    return stat.size;
  } catch {
    return 0;
  }
}

/** Delete partial download files */
async function cleanPartial(partialPath: string, metaPath: string) {
  await Deno.remove(partialPath).catch(() => {});
  await Deno.remove(metaPath).catch(() => {});
}

/**
 * Download a file with resumable download, SHA256 verification, and retry.
 *
 * Flow:
 * 1. Check final file — if exists and SHA256 matches, skip.
 *    If SHA256 mismatches, delete and re-download.
 * 2. Check .partial file — resume via HTTP Range if possible.
 * 3. Stream to .partial with progress reporting.
 * 4. On completion — verify SHA256, rename .partial → final.
 * 5. On error — keep .partial for resume, retry with backoff.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  expectedSha256?: string,
): Promise<void> {
  await ensureDir(dirname(destPath));

  // Check final file (cache hit)
  try {
    const stat = await Deno.stat(destPath);
    if (stat.size > 0) {
      if (expectedSha256) {
        console.log(`  Cached file found, verifying SHA256...`);
        const actual = await sha256Hex(destPath);
        if (actual === expectedSha256.toLowerCase()) {
          console.log(`  Cache valid: ${destPath} (${formatBytes(stat.size)})`);
          return;
        }
        console.warn(`  Cache corrupted, will re-download`);
        await Deno.remove(destPath);
      } else {
        console.log(`  Already downloaded: ${destPath} (${formatBytes(stat.size)})`);
        return;
      }
    }
  } catch {
    // File doesn't exist
  }

  const partialPath = destPath + ".partial";
  const metaPath = destPath + ".partial.meta";
  const maxAttempts = DEFAULT_RETRY_COUNT + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let downloaded = 0;

    try {
      // Determine resume point
      let startByte = await getResumePoint(partialPath, metaPath, url);

      // HTTP request with optional Range header
      const headers: Record<string, string> = {};
      if (startByte > 0) {
        headers["Range"] = `bytes=${startByte}-`;
        console.log(`  Resuming from ${formatBytes(startByte)}...`);
      } else {
        console.log(`  Downloading: ${url}`);
      }

      const resp = await httpDownload(url, { headers });

      // Determine total size and validate Range response
      let totalSize: number;
      if (resp.status === 206 && startByte > 0) {
        const contentRange = resp.headers.get("content-range");
        if (contentRange) {
          // Content-Range: bytes 200-999/1000
          totalSize = parseInt(contentRange.split("/")[1]) || 0;
        } else {
          totalSize = startByte + Number(resp.headers.get("content-length") ?? 0);
        }
      } else {
        // 200: full response — server ignored Range or fresh download
        if (startByte > 0) {
          console.warn(`  Server does not support Range, restarting...`);
          startByte = 0;
        }
        totalSize = Number(resp.headers.get("content-length") ?? 0);
      }

      // Write meta
      const meta: DownloadMeta = { url, totalSize };
      await Deno.writeTextFile(metaPath, JSON.stringify(meta));

      // Open partial file (append if resuming, truncate if fresh)
      const file = await Deno.open(partialPath, {
        write: true,
        create: true,
        append: startByte > 0,
        truncate: startByte === 0,
      });

      downloaded = startByte;
      const reader = resp.body!.getReader();
      const interactive = Deno.stderr.isTerminal();

      try {
        if (interactive && totalSize > 0) {
          const bar = new ProgressBar(Deno.stderr.writable, {
            max: totalSize,
            value: startByte,
            fillChar: "\u2588",
            emptyChar: "\u2591",
            keepOpen: true,
            fmt(f: ProgressBarFormatter) {
              const dt = (f.time - f.previousTime) / 1000;
              const speed = dt > 0 ? (f.value - f.previousValue) / dt : 0;
              return `  ${f.styledTime()}${f.progressBar}${f.styledData()} ${formatBytes(speed)}/s`;
            },
          });
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await file.write(value);
            downloaded += value.length;
            bar.add(value.length);
          }
          await bar.end();
        } else {
          const startTime = Date.now();
          let lastReportTime = startTime;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await file.write(value);
            downloaded += value.length;

            const now = Date.now();
            if (now - lastReportTime >= CI_INTERVAL_MS) {
              const elapsed = (now - startTime) / 1000;
              const speed = elapsed > 0 ? (downloaded - startByte) / elapsed : 0;
              const pct = totalSize > 0 ? Math.round((downloaded / totalSize) * 100) : 0;
              console.log(
                `  Progress: ${pct}% (${formatBytes(downloaded)} / ${formatBytes(totalSize)})  ${formatBytes(speed)}/s`,
              );
              lastReportTime = now;
            }
          }

          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? (downloaded - startByte) / elapsed : 0;
          console.log(
            `  Done: ${formatBytes(downloaded)} in ${elapsed.toFixed(1)}s (${formatBytes(speed)}/s)`,
          );
        }
      } finally {
        file.close();
      }

      // Download complete — verify SHA256
      if (expectedSha256) {
        console.log(`  Verifying SHA256...`);
        const actual = await sha256Hex(partialPath);
        if (actual !== expectedSha256.toLowerCase()) {
          // Data is bad, discard everything and retry from scratch
          await cleanPartial(partialPath, metaPath);
          throw new Error("SHA256 mismatch after download");
        }
        console.log(`  SHA256 OK`);
      }

      // Finalize: .partial → final
      await Deno.rename(partialPath, destPath);
      await Deno.remove(metaPath).catch(() => {});
      return;
    } catch (e) {
      const err = e as Error;
      // If no data was received at all (request-level error), clean partial
      // to avoid stale Range resume on next attempt
      if (downloaded === 0) {
        await cleanPartial(partialPath, metaPath);
      }

      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
        console.warn(`  Error: ${err.message}`);
        console.warn(`  Retry ${attempt}/${DEFAULT_RETRY_COUNT} in ${(delay / 1000).toFixed(0)}s...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}
