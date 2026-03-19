/** Base URL for CUDA redistributable packages */
export const CUDA_REDIST_BASE_URL =
  "https://developer.download.nvidia.com/compute/cuda/redist";

/** Base URL for cuDNN redistributable packages */
export const CUDNN_REDIST_BASE_URL =
  "https://developer.download.nvidia.com/compute/cudnn/redist";

/** Target platform */
export const PLATFORM = "windows-x86_64";

/**
 * CUDA runtime packages to download.
 * These are the shared libraries (DLLs) needed at runtime.
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
