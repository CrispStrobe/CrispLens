# Automated License Generation Workflow

This document outlines the process for generating a unified `licenses.json` file for projects that combine different ecosystems (e.g., Tauri/Rust + Svelte/NPM or Electron/NPM + Python/C++).

## 1. Prerequisites

### Tools
- **NPM**: `license-report` (standard for Node.js)
- **Rust**: `cargo-license` (standard for Rust/Cargo)

### Installation
```bash
npm install -D license-report
cargo install cargo-license
```

## 2. The Generation Script

Create a script (e.g., `scripts/generate-licenses.js`) to bridge the gap. The goal is to produce a single, normalized JSON array.

### Core Logic
1. **NPM Scanning**: Run `npx license-report --output=json --only=prod`. This filters out devDependencies that aren't shipped.
2. **Rust Scanning**: Run `cargo-license --json`. 
3. **Normalization**:
   - Rust's `cargo-license` often returns authors as a pipe-separated string (`Author A | Author B`). Convert these to a clean comma-separated list.
   - Map fields to a common schema: `name`, `version`, `license`, `author`, `link`, `source` (e.g., "Frontend" vs "Backend").
4. **Output**: Save to a public/static directory (e.g., `static/licenses.json`) so the frontend can `fetch` it at runtime.

### Reference Script (Node.js)
```javascript
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

// 1. NPM (Prod only)
const npmOutput = execSync('npx license-report --output=json --only=prod').toString();
const npmLicenses = JSON.parse(npmOutput).map(dep => ({
    name: dep.name,
    version: dep.installedVersion,
    license: dep.licenseType,
    author: dep.author,
    link: `https://www.npmjs.com/package/${dep.name}`,
    source: 'Frontend'
}));

// 2. Rust
const rustOutput = execSync('cd src-tauri && cargo-license --json').toString();
const rustLicenses = JSON.parse(rustOutput).map(dep => ({
    name: dep.name,
    version: dep.version,
    license: dep.license || 'Unknown',
    author: typeof dep.authors === 'string' ? dep.authors.replace(/\|/g, ', ') : 'Various',
    link: dep.repository || `https://crates.io/crates/${dep.name}`,
    source: 'Backend'
}));

// 3. Save
const combined = [...npmLicenses, ...rustLicenses].sort((a, b) => a.name.localeCompare(b.name));
writeFileSync('./static/licenses.json', JSON.stringify(combined, null, 2));
```

## 3. Automation

Add a command to `package.json` to ensure the file is updated before releases:
```json
"scripts": {
  "licenses:gen": "node scripts/generate-licenses.js"
}
```

## 4. UI Implementation

### Data Loading
In the frontend (Svelte/React/etc.), `fetch` the generated file on mount:
```javascript
let licenses = [];
async function load() {
  const res = await fetch('/licenses.json');
  licenses = await res.json();
}
```

### Features to Include
1. **Total Count**: Users are often surprised by the number of transitive dependencies (e.g., 900+). Showing the count provides transparency.
2. **Search/Filter**: Essential for navigating large lists. Filter by `name`, `license`, or `author`.
3. **External Links**: Use the appropriate shell-open command (Tauri's `opener` or Electron's `shell.openExternal`) to allow users to visit source repositories.
4. **Source Badges**: Visually distinguish between backend and frontend dependencies.

## 5. Why so many licenses?
Explain to the user that modern frameworks (Tauri, Electron) rely on a deep tree of transitive dependencies. Even if you only use 10 direct libraries, those libraries may pull in hundreds of others (like `zbus` or `async-executor`) that are legally required to be attributed if they are compiled into the final binary.
