import { ProgressBar } from "@std/cli/unstable-progress-bar";
import type { ProgressBarFormatter } from "@std/cli/unstable-progress-bar";
import { ensureDir } from "@std/fs/ensure-dir";
import { dirname } from "@std/path";
import { httpDownload } from "./http.ts";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** CI log interval */
const CI_INTERVAL_MS = 5_000;

/**
 * Compute SHA256 hex digest of a file.
 */
async function sha256Hex(filePath: string): Promise<string> {
  const data = await Deno.readFile(filePath);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Download a file with progress reporting.
 * - Interactive terminal: @std/cli ProgressBar with speed indicator.
 * - CI / piped: periodic log lines (every ~5 s).
 *
 * If a cached file exists and `expectedSha256` is provided, verifies the cache.
 * On mismatch or incomplete file, deletes and re-downloads automatically.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  expectedSha256?: string,
): Promise<void> {
  await ensureDir(dirname(destPath));

  // Check cached file
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
        console.warn(`  Cache corrupted (SHA256 mismatch), re-downloading...`);
        await Deno.remove(destPath);
      } else {
        console.log(`  Already downloaded: ${destPath} (${formatBytes(stat.size)})`);
        return;
      }
    }
  } catch {
    // File doesn't exist, proceed
  }

  console.log(`  Downloading: ${url}`);
  const resp = await httpDownload(url);

  const total = Number(resp.headers.get("content-length") ?? 0);
  const reader = resp.body!.getReader();
  const file = await Deno.open(destPath, {
    write: true,
    create: true,
    truncate: true,
  });

  const interactive = Deno.stderr.isTerminal();

  try {
    let downloaded = 0;

    if (interactive && total > 0) {
      // Terminal: use @std/cli ProgressBar (writes to stderr)
      const bar = new ProgressBar(Deno.stderr.writable, {
        max: total,
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
      // CI: periodic log lines
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
          const speed = elapsed > 0 ? downloaded / elapsed : 0;
          const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          console.log(
            `  Progress: ${pct}% (${formatBytes(downloaded)} / ${formatBytes(total)})  ${formatBytes(speed)}/s`,
          );
          lastReportTime = now;
        }
      }

      // Final CI line
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? downloaded / elapsed : 0;
      console.log(
        `  Done: ${formatBytes(downloaded)} in ${elapsed.toFixed(1)}s (${formatBytes(speed)}/s)`,
      );
    }
  } finally {
    file.close();
  }

  // Verify freshly downloaded file
  if (expectedSha256) {
    console.log(`  Verifying SHA256...`);
    const actual = await sha256Hex(destPath);
    if (actual !== expectedSha256.toLowerCase()) {
      await Deno.remove(destPath);
      throw new Error(
        `SHA256 mismatch after download.\n    Expected: ${expectedSha256}\n    Got:      ${actual}`,
      );
    }
    console.log(`  SHA256 OK`);
  }
}
