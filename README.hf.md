---
title: CrispLens
emoji: 📸
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
---

# CrispLens v4 (Docker)

Self-contained face recognition and management system.

## Hugging Face Space Deployment

This Space runs the **CrispLens v4 Node.js API** which serves the **Svelte UI**.

- **Inference:** Runs on the Space CPU/GPU using ONNX Runtime.
- **Persistence:** Mount a Dataset to `/data` to persist the SQLite database.
- **Standalone Mode:** Can still be used in "Standalone" mode within your browser, keeping all data local to your machine.

## Build Instructions

If building manually:
```bash
docker build -f Dockerfile.hf -t crisplens-hf .
docker run -p 7860:7860 crisplens-hf
```
