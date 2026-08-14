# ROS2 Map Editor 🤖🗺️

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-blue)](https://harsha200628.github.io/ros2-map-editor/)
[![IEEE RA-L](https://img.shields.io/badge/Paper-IEEE%20RA--L-red)](https://github.com/harsha200628/ros2-map-editor)

> **A zero-installation, purely browser-based tool for semantically correct occupancy-grid post-processing, navigation-aware path preview, and ICP-based multi-session map fusion — designed for Nav2-based mobile robotics workflows.**

---

## Features at a Glance

| Feature | This Tool | GIMP | RViz2 | map_editor | Foxglove |
|---|:---:|:---:|:---:|:---:|:---:|
| Semantic editing (enforces {0, 205, 254}) | ✅ | ❌ | Partial | ✅ | ❌ |
| Offline / zero-installation / no ROS | ✅ | ✅ | ❌ | ❌ | ✅ |
| Map merging (ICP auto-alignment) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Nav2-inspired costmap inflation preview | ✅ | ❌ | Partial* | ❌ | Partial* |
| A\* path planning preview | ✅ | ❌ | ❌ | ❌ | ❌ |
| Open source | ✅ | ✅ | ✅ | ✅ | ✅ |

\* Requires a running Nav2/ROS2 stack.

---

## What Problem Does This Solve?

Raw SLAM output (from `slam_toolbox`, Cartographer, etc.) is rarely deployment-ready:
- **Sensor noise** leaves stray pixels and phantom walls.
- **Generic raster editors (GIMP/Photoshop)** operate on RGB values — a single anti-aliased brush stroke silently corrupts the trinary occupancy alphabet `{0 = wall, 205 = unknown, 254 = free}` that `nav2_map_server` expects.
- **No feedback loop** — you cannot know whether a hand-drawn wall will block the only feasible path until you flash the map to the physical robot.
- **Multi-session fusion** — combining maps from multiple SLAM runs requires re-running SLAM or manually eyeballing an alignment.

This tool solves all three with no ROS installation, no server backend, and no build step.

---

## Features

### 🖌️ Semantic Map Editing
Every drawing primitive (brush, polygon, rectangle, circle) writes **only** one of the three legal occupancy values — `0`, `205`, or `254` — selected by the operator. Anti-aliased values that would corrupt `nav2_map_server` are impossible by design.

- **Multi-level undo/redo** (Ctrl+Z / Ctrl+Shift+Z) — stack capped at **40 states** (≈80–120 MB for a 1024×1024 map on Chrome v114).
- Open path, closed path, solid-fill polygon modes.
- Rectangle and circle draw with fill/outline option.

### 🧹 Class-Aware Majority-Vote Noise Filter
Removes salt-and-pepper noise from raw SLAM output while **explicitly preserving unknown-space boundaries** — a property that median filtering does not guarantee on trinary maps.

**Algorithm:** For every wall or free pixel `p`, count its eight neighbours. If `p` is a wall (`0`) and ≥ 5 neighbours are free (`254`), reclassify `p` as free (erodes isolated wall speckle). If `p` is free (`254`) and ≥ 5 neighbours are wall (`0`), reclassify `p` as wall (fills isolated free-space pinholes). **Unknown pixels (`205`) are always skipped** to preserve their boundaries. One pass, O(WH).

> ⚠️ **Note:** The button is labelled "Auto-Clean Noise" in the UI. The underlying algorithm is a class-aware majority-vote filter as described above — distinct from a standard median filter.

**Benchmark result (10 synthetic maps, Table III of the companion paper):**

| Method | F1 @ 1% noise | F1 @ 3% noise | F1 @ 5% noise |
|---|:---:|:---:|:---:|
| No filter | 0.891 | 0.802 | 0.714 |
| Median filter | 0.943 | 0.891 | 0.843 |
| **Class-aware majority-vote (this tool)** | **0.961** | **0.934** | **0.907** |

### 🗺️ Nav2-Inspired Costmap Inflation Preview
Visualises the inflation exclusion zone for a user-configured robot radius ρ (m) **without a running Nav2 stack**. Computed via a multi-source BFS distance transform (octile costs: 1 for axis-aligned steps, √2 for diagonal) seeded from all wall pixels. The inflated-region boundary achieves mean **IoU = 0.87 ± 0.04** vs. Nav2 Humble `costmap_2d` (cost_scaling_factor = 10) on 5 real `slam_toolbox` maps.

### 🏃 Inflation-Aware A\* Path Planning Preview
Tests navigability **before** deploying to a physical robot.

- Snaps start/goal to nearest free cell via BFS if clicked inside a wall.
- 8-connected A\* with a flat-array binary min-heap (O(log N) push/pop) and a `Uint8Array` closed-set bitmask (O(1) membership).
- **Soft inflation penalty** discourages wall-hugging paths; unknown-space cells incur a light extra cost of 10.
- Path smoothed with a wall-aware sliding-window average (window = 8).
- Sub-second on maps up to ~1 Mpx (1024 × 1024): **mean 44.1 ± 3.2 ms** (Apple M1, Chrome v114, n=30).

### 🗺️➕🗺️ Map Merging with ICP Auto-Alignment
Combines maps from multiple SLAM sessions or multiple robots.

- Wall pixels of both maps are subsampled on a **stride-3 grid** and bucketed into a **uniform 2-D spatial hash** (cell size = 15 px) for amortised O(1) nearest-neighbour queries.
- Runs up to **25 Procrustes iterations** (Arun et al., 1987) until convergence or fewer than 10 correspondences.
- **ICP accuracy** on 5 synthetic indoor-environment pairs: 98% success at ±5°/±0.05 m initial error; 91% at ±15°/±0.20 m.
- Manual translate, rotate, and flip controls provided for coarse pre-alignment on highly symmetric maps.

### 📏 Metric Measurement & Waypoints
- **Measure:** line distance, multi-segment path length, and polygon area — all converted to metric units via the YAML resolution.
- **Waypoints:** click-and-drag to set position + heading; exports quaternion-tagged JSON (`PoseStamped`-compatible) for direct use in a Nav2 autonomy stack.

### 💻 Zero-Installation
- Runs entirely in the browser (HTML5 Canvas + vanilla JavaScript ES2019).
- No build step, no server, no uploaded data leaving the client.
- Open `index.html` locally or visit the live demo.

---

## Getting Started

```bash
# Option 1: Clone and open locally
git clone https://github.com/harsha200628/ros2-map-editor.git
cd ros2-map-editor
# Open index.html in Chrome, Firefox, Edge, or Safari

# Option 2: Live demo (no install)
# https://harsha200628.github.io/ros2-map-editor/
```

1. Click **Load PGM** — select your SLAM map (P5 binary or P2 ASCII).
2. Click **Load YAML** — load the map metadata (resolution, origin).
3. Edit using the left sidebar tools.
4. Use the right sidebar for noise filtering, inflation preview, and A* path testing.
5. Click **Export PGM + YAML** — ready for `nav2_map_server`.

---

## File Structure

```
ros2-map-editor/
├── index.html          # UI layout (dual-sidebar, header, status bar)
├── style.css           # Styling — light/dark theme, responsive layout
├── script.js           # All algorithms: A*, ICP, distance transform, editing
├── benchmarks/         # Reproducible evaluation scripts (Tables II–V of the paper)
│   ├── README.md
│   ├── generate_synthetic_maps.py
│   ├── benchmark_latency.js
│   ├── benchmark_noise_filter.py
│   ├── benchmark_icp.py
│   └── results/
│       ├── latency_results.csv
│       ├── noise_filter_results.csv
│       └── icp_results.csv
├── CITATION.cff        # Machine-readable citation metadata
└── LICENSE             # MIT License
```

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space + Drag` or `Middle-Mouse Drag` | Pan |
| `Scroll` | Zoom in/out |
| `Ctrl + Z` | Undo |
| `Ctrl + Shift + Z` | Redo |
| `D` | Brush Draw |
| `G` | Polygon Draw |
| `M` | Measure |
| `R` | Rectangle Draw |
| `C` | Circle Draw |
| `W` | Waypoint |

---

## Reproducing Paper Results

All benchmark scripts and pre-run results for **Tables II–V** of the companion IEEE RA-L paper are in the [`/benchmarks`](benchmarks/) folder. See [`benchmarks/README.md`](benchmarks/README.md) for setup and run instructions. Raw CSV outputs are provided so results can be verified without re-running.

---

## Citation

If you use this tool in your research, please cite:

```bibtex
@article{harsha2026ros2mapeditor,
  author  = {GC Harsha Vardhan Reddy},
  title   = {{ROS2 Map Editor}: A Zero-Installation Browser Tool for Semantic
             Occupancy-Grid Editing, Navigation-Aware Path Preview, and
             {ICP}-Based Map Fusion},
  journal = {IEEE Robotics and Automation Letters},
  year    = {2026},
  url     = {https://github.com/harsha200628/ros2-map-editor}
}
```

Or use the [`CITATION.cff`](CITATION.cff) file (GitHub auto-parses this into a "Cite this repository" button).

---

## License

This project is released under the [MIT License](LICENSE).

© 2026 GC Harsha Vardhan Reddy — Department of EECE, GITAM Deemed to be University, Bengaluru, India.
