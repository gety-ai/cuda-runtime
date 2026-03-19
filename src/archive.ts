import { ensureDir } from "@std/fs/ensure-dir";
import { walk } from "@std/fs/walk";
import { basename, dirname, extname, join, resolve } from "@std/path";
import { BlobReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { type OS, runtimeLibDir } from "./config.ts";

/**
 * Extract an archive to a destination directory.
 * - .zip: Pure JS extraction via zip.js (cross-platform, no external tools)
 * - .tar.xz: tar command (Linux)
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<void> {
  await ensureDir(destDir);
  const name = basename(archivePath);
  console.log(`  Extracting: ${name}`);

  if (name.endsWith(".tar.xz")) {
    await extractTarXz(archivePath, destDir);
  } else if (name.endsWith(".zip")) {
    await extractZip(archivePath, destDir);
  } else {
    throw new Error(`Unsupported archive format: ${name}`);
  }
}

/** Extract a .tar.xz archive using the tar command */
async function extractTarXz(
  archivePath: string,
  destDir: string,
): Promise<void> {
  const cmd = new Deno.Command("tar", {
    args: ["-xf", archivePath, "-C", destDir],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (result.code !== 0) {
    const err = new TextDecoder().decode(result.stderr);
    throw new Error(`Failed to extract ${basename(archivePath)}: ${err}`);
  }
}

/** Extract a .zip archive using zip.js (pure JS, no external tools) */
async function extractZip(
  zipPath: string,
  destDir: string,
): Promise<void> {
  const data = await Deno.readFile(zipPath);
  const reader = new ZipReader(new BlobReader(new Blob([data])));
  try {
    const entries = await reader.getEntries();
    for (const entry of entries) {
      if (entry.directory) continue;
      if (!entry.getData) continue;
      const destPath = join(destDir, entry.filename);
      await ensureDir(dirname(destPath));
      const content = await entry.getData(new Uint8ArrayWriter());
      await Deno.writeFile(destPath, content);
    }
  } finally {
    await reader.close();
  }
}

/**
 * Collect runtime library files from extracted packages.
 * - Windows: .dll files from bin/ directories
 * - Linux: .so files (including versioned like .so.12) from lib/ directories
 *
 * @param allowPrefixes If provided, only collect files whose name starts with
 *   one of these prefixes (used by the minimal profile).
 */
export async function collectRuntimeLibs(
  extractDir: string,
  outputDir: string,
  os: OS,
  allowPrefixes?: string[],
): Promise<string[]> {
  await ensureDir(outputDir);
  const collected: string[] = [];
  const libDir = runtimeLibDir(os);

  for await (const entry of walk(extractDir, { includeDirs: false })) {
    const name = basename(entry.path);

    // Check the file is inside the correct lib directory (bin/ or lib/)
    const pathParts = entry.path.split(/[/\\]/);
    if (!pathParts.includes(libDir)) continue;

    // Match runtime library files by extension
    if (os === "windows") {
      if (extname(name).toLowerCase() !== ".dll") continue;
    } else {
      // Linux: match .so and versioned .so.X.Y.Z
      if (!name.includes(".so")) continue;
    }

    // Apply prefix allowlist filter (minimal profile)
    if (allowPrefixes && !allowPrefixes.some((p) => name.startsWith(p))) {
      continue;
    }

    // Skip if already collected (avoid duplicates)
    const destPath = join(outputDir, name);
    try {
      await Deno.stat(destPath);
      continue;
    } catch {
      // Not yet collected
    }

    await Deno.copyFile(entry.path, destPath);
    collected.push(name);
  }

  return collected.sort();
}

/**
 * Create a compressed archive from a directory.
 * - Windows: ZIP via 7z or PowerShell
 * - Linux: tar.gz via tar
 */
export async function createArchive(
  inputDir: string,
  outputPath: string,
  os: OS,
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

  if (os === "linux" || outputPath.endsWith(".tar.gz")) {
    // tar.gz
    const cmd = new Deno.Command("tar", {
      args: ["-czf", absOutput, "-C", absInput, "."],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await cmd.output();
    if (result.code !== 0) {
      const err = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to create tar.gz: ${err}`);
    }
    console.log(`  Created tar.gz`);
    return;
  }

  // ZIP for Windows
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

  // PowerShell .NET fallback
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
