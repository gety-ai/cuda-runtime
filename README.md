# cuda-runtime

Download and package CUDA/cuDNN runtime libraries from NVIDIA's redistributable packages.

Uses NVIDIA's official `redistrib_*.json` manifests to download only the runtime components needed, then packages them into a single archive.

## Requirements

- [Deno](https://deno.com/) v2.x

## Usage

```bash
# Default: CUDA 12.6.3 + latest compatible cuDNN, full profile
deno run -A main.ts

# Specify CUDA version (cuDNN auto-detected)
deno run -A main.ts --cuda-version 12.8.1

# Minimal profile — only core libs
deno run -A main.ts --cuda-version 12.6.3 --profile minimal

# Cross-platform: package Linux libs on Windows (or vice versa)
deno run -A main.ts --cuda-version 12.6.3 --os linux --arch x86_64

# Specific cuDNN version
deno run -A main.ts --cuda-version 12.6.3 --cudnn-version 9.5.1

# Skip cuDNN
deno run -A main.ts --cuda-version 12.6.3 --cudnn-version ""
```

### Options

| Option | Default | Description |
|---|---|---|
| `--cuda-version` | `12.6.3` | CUDA toolkit version |
| `--cudnn-version` | `auto` | cuDNN version. `auto` finds the latest compatible, `""` skips cuDNN |
| `--os` | auto-detect | Target OS: `windows`, `linux` |
| `--arch` | auto-detect | Target architecture: `x86_64`, `aarch64` |
| `--profile` | `full` | `full` = all runtime libs, `minimal` = core subset only |
| `--output-dir` | `./output` | Output directory for the archive |
| `--work-dir` | `./tmp` | Working directory for downloads and extraction |
| `--skip-verify` | `false` | Skip SHA256 checksum verification |

### Supported Platforms

- `windows-x86_64`
- `linux-x86_64`
- `linux-aarch64`

## Profiles

**full** — All runtime libraries from the selected packages.

**minimal** — Core subset matching typical ML inference needs:

| | Windows | Linux |
|---|---|---|
| CUDA | cudart, cublas, cublasLt, cufft | cudart, cublas, cublasLt, nvrtc, curand, cufft |
| cuDNN | cudnn, graph, ops, heuristic, adv, cnn, engines_precompiled, engines_runtime_compiled | same |

## Included Packages

| Package | Description |
|---|---|
| `cuda_cudart` | CUDA Runtime API |
| `cuda_nvrtc` | Runtime Compilation (JIT) |
| `libcublas` | Basic Linear Algebra |
| `libcufft` | Fast Fourier Transform |
| `libcurand` | Random Number Generation |
| `libcusolver` | Linear Solvers |
| `libcusparse` | Sparse Matrix Operations |
| `libnvjitlink` | JIT Link Library |
| `cudnn` | Deep Neural Network Library |

## GitHub Actions Workflow

The included workflow (`.github/workflows/package-runtime.yml`) supports:

- Manual dispatch with configurable CUDA version, cuDNN version, platforms, and profile
- Multi-platform matrix builds (Windows + Linux in parallel)
- Download caching between runs
- Optional GitHub Release creation with archives attached

Trigger via **Actions > Package CUDA Runtime > Run workflow**.

## Output

Archives are named following this pattern:

```
cuda-{cuda_ver}-cudnn-{cudnn_ver}-{platform}.zip          # full, Windows
cuda-{cuda_ver}-cudnn-{cudnn_ver}-{platform}.tar.gz        # full, Linux
cuda-{cuda_ver}-cudnn-{cudnn_ver}-{platform}-minimal.zip   # minimal, Windows
```

Each archive includes a `VERSION.json` with metadata (versions, platform, profile, file list).
