import { ensureDir } from "@std/fs/ensure-dir";
import { dirname } from "@std/path";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** Detect if stdout is an interactive terminal (not CI / piped) */
function isInteractive(): boolean {
  return Deno.stdout.isTerminal();
}

const BAR_WIDTH = 30;

/** Render a progress bar line for interactive terminals */
function renderBar(downloaded: number, total: number, bytesPerSec: number): string {
  const pct = total > 0 ? downloaded / total : 0;
  const filled = Math.round(BAR_WIDTH * pct);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(BAR_WIDTH - filled);
  const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
  const speed = bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "---";
  return `\r  ${bar} ${pctStr}  ${formatBytes(downloaded)} / ${formatBytes(total)}  ${speed}`;
}

/** Format a CI log line for non-interactive output */
function renderCiLine(downloaded: number, total: number, bytesPerSec: number): string {
  const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
  const speed = bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "---";
  return `  Progress: ${pct}% (${formatBytes(downloaded)} / ${formatBytes(total)})  ${speed}`;
}

/**
 * Download a file with progress reporting.
 * - Interactive terminal: in-place progress bar with speed.
 * - CI / piped: periodic log lines (every ~5 s).
 * Skips download if the file already exists with non-zero size.
 */
export async function downloadFile(
  url: string,
  destPath: string,
): Promise<void> {
  await ensureDir(dirname(destPath));

  // Skip if already downloaded
  try {
    const stat = await Deno.stat(destPath);
    if (stat.size > 0) {
      console.log(`  Already downloaded: ${destPath} (${formatBytes(stat.size)})`);
      return;
    }
  } catch {
    // File doesn't exist, proceed
  }

  console.log(`  Downloading: ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} downloading ${url}`);
  }

  const total = Number(resp.headers.get("content-length") ?? 0);
  const reader = resp.body!.getReader();
  const file = await Deno.open(destPath, {
    write: true,
    create: true,
    truncate: true,
  });

  const interactive = isInteractive();
  const CI_INTERVAL_MS = 5_000;
  const encoder = new TextEncoder();

  try {
    let downloaded = 0;
    let lastReportTime = Date.now();
    const startTime = lastReportTime;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(value);
      downloaded += value.length;

      const now = Date.now();
      const elapsed = (now - startTime) / 1000;
      const speed = elapsed > 0 ? downloaded / elapsed : 0;

      if (interactive) {
        // Throttle terminal updates to avoid excessive writes (~100 ms)
        if (now - lastReportTime >= 100 || done) {
          await Deno.stdout.write(encoder.encode(renderBar(downloaded, total, speed)));
          lastReportTime = now;
        }
      } else {
        // CI: log every CI_INTERVAL_MS
        if (now - lastReportTime >= CI_INTERVAL_MS) {
          console.log(renderCiLine(downloaded, total, speed));
          lastReportTime = now;
        }
      }
    }

    // Final report
    const totalElapsed = (Date.now() - startTime) / 1000;
    const avgSpeed = totalElapsed > 0 ? downloaded / totalElapsed : 0;
    if (interactive) {
      await Deno.stdout.write(encoder.encode(renderBar(downloaded, total, avgSpeed)));
      console.log(""); // newline after bar
    } else {
      console.log(renderCiLine(downloaded, total, avgSpeed));
    }
  } finally {
    file.close();
  }
}

/**
 * Verify SHA256 checksum of a file.
 */
export async function verifySha256(
  filePath: string,
  expectedSha256: string,
): Promise<boolean> {
  if (!expectedSha256) return true;

  console.log(`  Verifying SHA256...`);
  const data = await Deno.readFile(filePath);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hashHex = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (hashHex !== expectedSha256.toLowerCase()) {
    console.error(
      `  SHA256 MISMATCH!\n    Expected: ${expectedSha256}\n    Got:      ${hashHex}`,
    );
    return false;
  }
  console.log(`  SHA256 OK`);
  return true;
}
