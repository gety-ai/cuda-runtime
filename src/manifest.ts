import {
  CUDA_REDIST_BASE_URL,
  CUDNN_REDIST_BASE_URL,
  type Platform,
} from "./config.ts";
import { http } from "./http.ts";

export interface PackageDownloadInfo {
  packageName: string;
  displayName: string;
  version: string;
  url: string;
  sha256: string;
  size: number;
}

// deno-lint-ignore no-explicit-any
type Manifest = Record<string, any>;

async function fetchManifest(url: string): Promise<Manifest> {
  console.log(`Fetching manifest: ${url}`);
  return await http.get(url).json();
}

/**
 * Compare two version strings numerically (e.g. "9.5.1" vs "9.20.0").
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Discover all available cuDNN versions from NVIDIA's redist directory listing,
 * then find the latest version that supports the given CUDA major version.
 *
 * The directory at CUDNN_REDIST_BASE_URL contains `redistrib_<ver>.json` files.
 * Each manifest has platform keys with `cuda<N>` sub-keys indicating compatibility.
 */
export async function findLatestCompatibleCudnn(
  cudaMajorVersion: number,
  platform: Platform,
): Promise<{ version: string; fullVersion: string }> {
  console.log(`Searching for latest cuDNN compatible with CUDA ${cudaMajorVersion} on ${platform}...`);

  // Fetch directory listing
  const html = await http.get(`${CUDNN_REDIST_BASE_URL}/`).text();

  // Extract version strings from redistrib_<ver>.json links.
  // Prefer short versions (e.g. "9.5.1") over long ones (e.g. "9.5.1.17")
  // since the short form is the "release" manifest.
  const allVersions: string[] = [];
  for (const m of html.matchAll(/redistrib_([\d.]+)\.json/g)) {
    allVersions.push(m[1]);
  }

  // Keep only short-form versions (major.minor.patch, 3 parts) and deduplicate
  const shortVersions = [...new Set(
    allVersions.filter((v) => v.split(".").length <= 3),
  )];
  // Sort descending so we check the latest first
  shortVersions.sort((a, b) => compareVersions(b, a));

  // Check each version's manifest for CUDA compatibility
  for (const ver of shortVersions) {
    const manifestUrl = `${CUDNN_REDIST_BASE_URL}/redistrib_${ver}.json`;
    try {
      const manifest: Manifest = await http.get(manifestUrl).json();
      const cudnn = manifest["cudnn"];
      if (!cudnn?.[platform]) continue;

      const platformInfo = cudnn[platform];
      if (platformInfo[`cuda${cudaMajorVersion}`]) {
        console.log(`  Found: cuDNN ${ver} (${cudnn.version}) supports CUDA ${cudaMajorVersion}`);
        return { version: ver, fullVersion: cudnn.version };
      }
    } catch {
      // Skip manifests that fail to fetch/parse
    }
  }

  throw new Error(
    `No cuDNN version found that supports CUDA ${cudaMajorVersion} on ${platform}`,
  );
}

/**
 * Resolve CUDA runtime packages from the redistributable manifest.
 */
export async function resolveCudaPackages(
  cudaVersion: string,
  packageNames: string[],
  platform: Platform,
): Promise<PackageDownloadInfo[]> {
  const manifest = await fetchManifest(
    `${CUDA_REDIST_BASE_URL}/redistrib_${cudaVersion}.json`,
  );
  const results: PackageDownloadInfo[] = [];

  for (const name of packageNames) {
    const pkg = manifest[name];
    if (!pkg) {
      console.warn(`  Warning: '${name}' not found in CUDA ${cudaVersion} manifest, skipping`);
      continue;
    }
    const platformInfo = pkg[platform];
    if (!platformInfo) {
      console.warn(`  Warning: '${name}' has no ${platform} build, skipping`);
      continue;
    }
    results.push({
      packageName: name,
      displayName: pkg.name ?? name,
      version: pkg.version ?? "unknown",
      url: `${CUDA_REDIST_BASE_URL}/${platformInfo.relative_path}`,
      sha256: platformInfo.sha256 ?? "",
      size: Number(platformInfo.size ?? 0),
    });
  }
  return results;
}

/**
 * Resolve cuDNN packages from the redistributable manifest.
 * cuDNN manifests may have CUDA-version-specific sub-keys under each platform.
 */
export async function resolveCudnnPackages(
  cudnnVersion: string,
  cudaMajorVersion: number,
  platform: Platform,
): Promise<PackageDownloadInfo[]> {
  const manifest = await fetchManifest(
    `${CUDNN_REDIST_BASE_URL}/redistrib_${cudnnVersion}.json`,
  );
  const results: PackageDownloadInfo[] = [];

  for (const [name, pkg] of Object.entries(manifest)) {
    if (typeof pkg !== "object" || pkg === null) continue;
    // deno-lint-ignore no-explicit-any
    const pkgObj = pkg as any;
    // Skip manifest metadata fields
    if (!pkgObj.version) continue;

    const platformInfo = pkgObj[platform];
    if (!platformInfo) continue;

    // cuDNN platform info may have cuda-version sub-keys like "cuda12"
    let archiveInfo = platformInfo;
    if (platformInfo[`cuda${cudaMajorVersion}`]) {
      archiveInfo = platformInfo[`cuda${cudaMajorVersion}`];
    } else if (!platformInfo.relative_path) {
      // Try to find any cuda key
      const cudaKey = Object.keys(platformInfo).find((k: string) =>
        k.startsWith("cuda")
      );
      if (cudaKey) {
        archiveInfo = platformInfo[cudaKey];
      } else {
        console.warn(`  Warning: '${name}' has no download for CUDA ${cudaMajorVersion}, skipping`);
        continue;
      }
    }

    if (!archiveInfo?.relative_path) {
      console.warn(`  Warning: '${name}' missing download path, skipping`);
      continue;
    }

    results.push({
      packageName: name,
      displayName: pkgObj.name ?? name,
      version: pkgObj.version ?? cudnnVersion,
      url: `${CUDNN_REDIST_BASE_URL}/${archiveInfo.relative_path}`,
      sha256: archiveInfo.sha256 ?? "",
      size: Number(archiveInfo.size ?? 0),
    });
  }
  return results;
}
