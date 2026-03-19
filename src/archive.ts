import { ensureDir } from "@std/fs/ensure-dir";
import { walk } from "@std/fs/walk";
import { join, basename, dirname, resolve } from "@std/path";

/**
 * Extract a ZIP archive.
 * Uses `tar` (built-in on Windows 10+), falls back to PowerShell.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
): Promise<void> {
  await ensureDir(destDir);
  console.log(`  Extracting: ${basename(zipPath)}`);

  // Try tar first (built-in on Windows 10+)
  try {
    const cmd = new Deno.Command("tar", {
      args: ["-xf", zipPath, "-C", destDir],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (result.code === 0) return;
    console.warn(`  tar failed (code ${result.code}), trying PowerShell...`);
  } catch {
    console.warn(`  tar not available, trying PowerShell...`);
  }

  // PowerShell fallback
  const cmd = new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (result.code !== 0) {
    const err = new TextDecoder().decode(result.stderr);
    throw new Error(`Failed to extract ${zipPath}: ${err}`);
  }
}

/**
 * Collect all DLL files from `bin/` directories within the extracted packages.
 */
export async function collectDlls(
  extractDir: string,
  outputDir: string,
): Promise<string[]> {
  await ensureDir(outputDir);
  const collected: string[] = [];

  for await (const entry of walk(extractDir, {
    exts: [".dll"],
    includeDirs: false,
  })) {
    // Only collect DLLs from bin/ directories
    const pathParts = entry.path.split(/[/\\]/);
    if (!pathParts.includes("bin")) continue;

    const dllName = basename(entry.path);

    // Skip if already collected (avoid duplicates from different packages)
    const destPath = join(outputDir, dllName);
    try {
      await Deno.stat(destPath);
      continue;
    } catch {
      // Not yet collected
    }

    await Deno.copyFile(entry.path, destPath);
    collected.push(dllName);
  }

  return collected.sort();
}

/**
 * Create a ZIP archive from a directory.
 * Tries 7z first, falls back to PowerShell .NET compression.
 */
export async function createZip(
  inputDir: string,
  outputPath: string,
): Promise<void> {
  const absInput = resolve(inputDir);
  const absOutput = resolve(outputPath);
  await ensureDir(dirname(absOutput));

  // Remove existing output file
  try {
    await Deno.remove(absOutput);
  } catch {
    // Doesn't exist
  }

  console.log(`Creating archive: ${basename(outputPath)}`);

  // Try 7z first (available on GitHub Actions runners)
  try {
    const cmd = new Deno.Command("7z", {
      args: ["a", "-tzip", absOutput, join(absInput, "*")],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (result.code === 0) {
      console.log(`  Created with 7z`);
      return;
    }
  } catch {
    // 7z not available
  }

  // PowerShell .NET fallback (no 2GB limit unlike Compress-Archive)
  const psScript =
    `Add-Type -Assembly System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${absInput}', '${absOutput}')`;
  const cmd = new Deno.Command("powershell", {
    args: ["-NoProfile", "-Command", psScript],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (result.code !== 0) {
    const err = new TextDecoder().decode(result.stderr);
    throw new Error(`Failed to create ZIP: ${err}`);
  }
  console.log(`  Created with PowerShell`);
}
