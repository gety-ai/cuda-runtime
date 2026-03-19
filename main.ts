import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { ensureDir } from "@std/fs/ensure-dir";
import {
  CUDA_RUNTIME_PACKAGES,
  VALID_PLATFORMS,
  buildPlatform,
  detectOS,
  detectArch,
  type OS,
  type Arch,
} from "./src/config.ts";
import {
  findLatestCompatibleCudnn,
  resolveCudaPackages,
  resolveCudnnPackages,
  type PackageDownloadInfo,
} from "./src/manifest.ts";
import { downloadFile, formatBytes, verifySha256 } from "./src/download.ts";
import { collectRuntimeLibs, createArchive, extractArchive } from "./src/archive.ts";

function printUsage() {
  console.log(`CUDA Runtime Packager
Download and package CUDA/cuDNN runtime libraries.

Usage:
  deno run -A main.ts [options]

Options:
  --cuda-version <ver>   CUDA version (default: 12.6.3)
  --cudnn-version <ver>  cuDNN version (default: auto)
                         "auto" = find latest compatible version
                         ""     = skip cuDNN
  --os <os>              Target OS: windows, linux (default: auto-detect)
  --arch <arch>          Target arch: x86_64, aarch64 (default: auto-detect)
  --output-dir <dir>     Output directory (default: ./output)
  --work-dir <dir>       Working directory for downloads (default: ./tmp)
  --skip-verify          Skip SHA256 verification
  --help                 Show this help

Supported platforms: ${VALID_PLATFORMS.join(", ")}

Examples:
  deno run -A main.ts --cuda-version 12.8.1
  deno run -A main.ts --cuda-version 12.6.3 --os linux --arch x86_64
  deno run -A main.ts --cuda-version 12.6.3 --cudnn-version 9.5.1
  deno run -A main.ts --cuda-version 12.6.3 --cudnn-version ""
`);
}

const args = parseArgs(Deno.args, {
  string: ["cuda-version", "cudnn-version", "os", "arch", "output-dir", "work-dir"],
  boolean: ["help", "skip-verify"],
  default: {
    "cuda-version": "12.6.3",
    "cudnn-version": "auto",
    "output-dir": "./output",
    "work-dir": "./tmp",
  },
});

if (args.help) {
  printUsage();
  Deno.exit(0);
}

const cudaVersion = args["cuda-version"];
let cudnnVersion = args["cudnn-version"];
const cudaMajor = parseInt(cudaVersion.split(".")[0]);
const os: OS = (args["os"] as OS) || detectOS();
const arch: Arch = (args["arch"] as Arch) || detectArch();
const platform = buildPlatform(os, arch);
const outputDir = args["output-dir"];
const workDir = args["work-dir"];
const skipVerify = args["skip-verify"];

console.log("=== CUDA Runtime Packager ===");
console.log(`CUDA version:  ${cudaVersion}`);
console.log(`Platform:      ${platform}`);

// Auto-detect cuDNN version if requested
if (cudnnVersion === "auto") {
  const result = await findLatestCompatibleCudnn(cudaMajor, platform);
  cudnnVersion = result.version;
}

console.log(`cuDNN version: ${cudnnVersion || "(skipped)"}`);
console.log(`Output dir:    ${outputDir}`);
console.log();

// Setup directories
const downloadDir = join(workDir, "downloads");
const extractDir = join(workDir, "extracted");
const collectDir = join(workDir, "collected");
await ensureDir(downloadDir);
await ensureDir(extractDir);
await ensureDir(collectDir);
await ensureDir(outputDir);

// Step 1: Resolve packages from NVIDIA redistributable manifests
console.log("--- Resolving CUDA packages ---");
const cudaPackages = await resolveCudaPackages(cudaVersion, CUDA_RUNTIME_PACKAGES, platform);
for (const pkg of cudaPackages) {
  console.log(`  ${pkg.displayName} v${pkg.version} (${formatBytes(pkg.size)})`);
}

let cudnnPackages: PackageDownloadInfo[] = [];
if (cudnnVersion) {
  console.log("\n--- Resolving cuDNN packages ---");
  cudnnPackages = await resolveCudnnPackages(cudnnVersion, cudaMajor, platform);
  for (const pkg of cudnnPackages) {
    console.log(`  ${pkg.displayName} v${pkg.version} (${formatBytes(pkg.size)})`);
  }
}

const allPackages = [...cudaPackages, ...cudnnPackages];
if (allPackages.length === 0) {
  console.error("Error: No packages resolved. Check version numbers.");
  Deno.exit(1);
}

const totalSize = allPackages.reduce((sum, p) => sum + p.size, 0);
console.log(`\nTotal download size: ${formatBytes(totalSize)}`);

// Step 2: Download all packages
console.log("\n--- Downloading packages ---");
for (const pkg of allPackages) {
  const fileName = pkg.url.split("/").pop()!;
  const destPath = join(downloadDir, fileName);
  console.log(`\n[${pkg.displayName}]`);
  await downloadFile(pkg.url, destPath);

  if (!skipVerify && pkg.sha256) {
    const ok = await verifySha256(destPath, pkg.sha256);
    if (!ok) {
      console.error(`SHA256 verification failed for ${fileName}`);
      Deno.exit(1);
    }
  }
}

// Step 3: Extract all packages
console.log("\n--- Extracting packages ---");
for (const pkg of allPackages) {
  const fileName = pkg.url.split("/").pop()!;
  const archivePath = join(downloadDir, fileName);
  const pkgExtractDir = join(extractDir, pkg.packageName);
  console.log(`\n[${pkg.displayName}]`);
  await extractArchive(archivePath, pkgExtractDir);
}

// Step 4: Collect runtime libraries
console.log("\n--- Collecting runtime libraries ---");
const libs = await collectRuntimeLibs(extractDir, collectDir, os);
console.log(`Collected ${libs.length} files:`);
for (const lib of libs) {
  console.log(`  ${lib}`);
}

// Step 5: Write metadata
const metadata = {
  cuda_version: cudaVersion,
  cudnn_version: cudnnVersion || null,
  platform,
  packages: allPackages.map((p) => ({
    name: p.packageName,
    display_name: p.displayName,
    version: p.version,
  })),
  files: libs,
  created_at: new Date().toISOString(),
};
await Deno.writeTextFile(
  join(collectDir, "VERSION.json"),
  JSON.stringify(metadata, null, 2),
);

// Step 6: Create output archive
const archiveExt = os === "windows" ? ".zip" : ".tar.gz";
const archiveNameParts = [`cuda-${cudaVersion}`];
if (cudnnVersion) archiveNameParts.push(`cudnn-${cudnnVersion}`);
archiveNameParts.push(platform);
const archiveName = archiveNameParts.join("-") + archiveExt;
const archivePath = join(outputDir, archiveName);

console.log("\n--- Creating archive ---");
await createArchive(collectDir, archivePath, os);

// Print summary
const archiveStat = await Deno.stat(archivePath);
console.log("\n=== Done! ===");
console.log(`Archive: ${archivePath}`);
console.log(`Size:    ${formatBytes(archiveStat.size)}`);
console.log(`Files:   ${libs.length}`);

// Write GitHub Actions outputs if running in CI
const githubOutput = Deno.env.get("GITHUB_OUTPUT");
if (githubOutput) {
  const outputs = [
    `cuda-version=${cudaVersion}`,
    `cudnn-version=${cudnnVersion || ""}`,
    `platform=${platform}`,
    `archive-name=${archiveName}`,
  ].join("\n") + "\n";
  await Deno.writeTextFile(githubOutput, outputs, { append: true });
  console.log("\nGitHub Actions outputs written.");
}
