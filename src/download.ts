import { ensureDir } from "@std/fs/ensure-dir";
import { dirname } from "@std/path";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Download a file with progress reporting.
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

  try {
    let downloaded = 0;
    const encoder = new TextEncoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(value);
      downloaded += value.length;
      if (total > 0) {
        const pct = Math.round((downloaded / total) * 100);
        await Deno.stdout.write(
          encoder.encode(
            `\r  Progress: ${pct}% (${formatBytes(downloaded)} / ${formatBytes(total)})`,
          ),
        );
      }
    }
    console.log(""); // newline after progress
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
