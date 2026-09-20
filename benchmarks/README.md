# Benchmarks — Reproducible Evaluation for Tables II–V

This folder contains all scripts and pre-run results needed to reproduce the
quantitative results reported in the companion paper:

> GC Harsha Vardhan Reddy, "2D Occupancy Grid Map Editor: A Zero-Installation Browser Tool
> for Semantic Occupancy-Grid Editing, Navigation-Aware Path Preview, and
> ICP-Based Map Fusion," 2026.

---

## Contents

| File | Purpose | Paper table |
|---|---|---|
| `generate_synthetic_maps.py` | Generates all synthetic PGM test maps (deterministic, seed=42) | Prerequisite for Tables II–IV |
| `benchmark_latency.js` | Measures execution latency of all four algorithm pipelines (Node.js) | Table II |
| `benchmark_noise_filter.py` | Computes pixel-level F1 of noise filter vs. ground truth | Table III |
| `benchmark_icp.py` | Measures ICP rotation/translation RMSE and convergence rate | Table IV |
| `results/latency_results.csv` | Pre-run output (Apple M1, Chrome v114, n=30 runs) | Table II |
| `results/noise_filter_results.csv` | Pre-run output (n=10 maps × 3 noise levels) | Table III |
| `results/icp_results.csv` | Pre-run output (n=25 trials × 4 error levels × 5 map pairs) | Table IV |

> **Note on Table V (Nav2 IoU comparison):** This benchmark requires a running
> Nav2 Humble stack with `costmap_2d`. The IoU values (mean 0.87 ± 0.04) were
> measured on 5 real `slam_toolbox` maps at ρ ∈ {0.2, 0.3, 0.5} m.
> Reproduction instructions are in `benchmark_nav2_iou.md` (requires ROS2 Humble).

---

## Environment Setup

### Python scripts (Tables III & IV)
```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install numpy scipy scikit-image pillow
```

### Node.js script (Table II)
```bash
node --version   # requires Node.js >= 18
```

---

## Running the Benchmarks

```bash
# Step 1: Generate all synthetic test maps
python3 generate_synthetic_maps.py
# → creates maps/ subdirectory with all PGM files

# Step 2: Latency benchmarks (Table II)
node benchmark_latency.js
# → writes results/latency_results.csv

# Step 3: Noise filter F1 benchmark (Table III)
python3 benchmark_noise_filter.py
# → writes results/noise_filter_results.csv

# Step 4: ICP accuracy benchmark (Table IV)
python3 benchmark_icp.py
# → writes results/icp_results.csv
```

---

## Reproducibility Notes

- All Python scripts use `numpy.random.default_rng(seed=42)` for deterministic output.
- Latency results in `results/latency_results.csv` were measured on Apple M1 / 16 GB RAM / Chrome v114. Your hardware will differ; the algorithmic complexity relationships (Table VI) will hold.
- The `maps/` directory is not committed to the repo (it is in `.gitignore`) — run `generate_synthetic_maps.py` first.
