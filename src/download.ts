import { ProgressBar } from "@std/cli/unstable-progress-bar";
import type { ProgressBarFormatter } from "@std/cli/unstable-progress-bar";
import { ensureDir } from "@std/fs/ensure-dir";
import { dirname } from "@std/path";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** CI log interval */
const CI_INTERVAL_MS = 5_000;

/**
 * Download a file with progress reporting.
 * - Interactive terminal: @std/cli ProgressBar with speed indicator.
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
