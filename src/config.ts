/** Base URL for CUDA redistributable packages */
export const CUDA_REDIST_BASE_URL =
  "https://developer.download.nvidia.com/compute/cuda/redist";

/** Base URL for cuDNN redistributable packages */
export const CUDNN_REDIST_BASE_URL =
  "https://developer.download.nvidia.com/compute/cudnn/redist";

/** Default retry count for HTTP requests */
export const DEFAULT_RETRY_COUNT = 3;

/** Supported OS values */
export type OS = "windows" | "linux";

/** Supported architecture values */
export type Arch = "x86_64" | "aarch64";

/** Platform string used as key in NVIDIA redistributable manifests */
export type Platform = `${OS}-${Arch}`;

/** Valid platform combinations that NVIDIA provides */
export const VALID_PLATFORMS: readonly Platform[] = [
  "windows-x86_64",
  "linux-x86_64",
  "linux-aarch64",
];

/** Detect OS from the current runtime */
export function detectOS(): OS {
  switch (Deno.build.os) {
    case "windows":
      return "windows";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported OS: ${Deno.build.os}`);
  }
}

/** Detect architecture from the current runtime */
export function detectArch(): Arch {
  switch (Deno.build.arch) {
    case "x86_64":
      return "x86_64";
    case "aarch64":
      return "aarch64";
    default:
      throw new Error(`Unsupported architecture: ${Deno.build.arch}`);
  }
}

/** Build a platform string and validate it */
export function buildPlatform(os: OS, arch: Arch): Platform {
  const platform: Platform = `${os}-${arch}`;
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(
      `Unsupported platform: ${platform} (valid: ${VALID_PLATFORMS.join(", ")})`,
    );
  }
  return platform;
}

/** Runtime library file extension by OS */
export function runtimeLibExt(os: OS): string {
  return os === "windows" ? ".dll" : ".so";
}

/** Directory name containing runtime libraries in NVIDIA packages */
export function runtimeLibDir(os: OS): string {
  return os === "windows" ? "bin" : "lib";
}

/**
 * CUDA runtime packages to download.
 * These are the shared libraries needed at runtime.
 */
export const CUDA_RUNTIME_PACKAGES = [
  "cuda_cudart", // CUDA Runtime API
  "cuda_nvrtc", // Runtime Compilation (JIT)
  "libcublas", // Basic Linear Algebra Subroutines
  "libcufft", // Fast Fourier Transform
  "libcurand", // Random Number Generation
  "libcusolver", // Dense/Sparse Linear Solvers
  "libcusparse", // Sparse Matrix Operations
  "libnvjitlink", // JIT Link Library (CUDA 12+)
];

/** Build profile — controls which runtime libraries are included */
export type Profile = "full" | "minimal";

export const VALID_PROFILES: readonly Profile[] = ["full", "minimal"];

/**
 * Filename prefixes for the minimal profile.
 * Uses prefixes (before the version number) so matching works across CUDA/cuDNN versions.
 * e.g. "cudart64_" matches "cudart64_12.dll" (CUDA 12) and "cudart64_13.dll" (CUDA 13).
 */
export const MINIMAL_PREFIXES: Record<OS, { cuda: string[]; cudnn: string[] }> = {
  windows: {
    cuda: [
      "cudart64_",
      "cublas64_",
      "cublasLt64_",
      "cufft64_",
    ],
    cudnn: [
      "cudnn64_",
      "cudnn_graph64_",
      "cudnn_ops64_",
      "cudnn_heuristic64_",
      "cudnn_adv64_",
      "cudnn_cnn64_",
      "cudnn_engines_precompiled64_",
      "cudnn_engines_runtime_compiled64_",
    ],
  },
  linux: {
    cuda: [
      "libcudart.so.",
      "libcublas.so.",
      "libcublasLt.so.",
      "libnvrtc.so.",
      "libcurand.so.",
      "libcufft.so.",
    ],
    cudnn: [
      "libcudnn.so.",
      "libcudnn_graph.so.",
      "libcudnn_ops.so.",
      "libcudnn_heuristic.so.",
      "libcudnn_adv.so.",
      "libcudnn_cnn.so.",
      "libcudnn_engines_precompiled.so.",
      "libcudnn_engines_runtime_compiled.so.",
    ],
  },
};
