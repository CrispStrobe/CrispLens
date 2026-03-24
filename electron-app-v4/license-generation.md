# Automated License Generation Workflow (Electron v4)

This document outlines the process for generating a unified `licenses.json` file for the CrispLens v4 project, which combines two Node.js ecosystems: the **Electron Backend** and the **Vite/Svelte Frontend**.

## 1. Prerequisites

### Tools
- **NPM**: `license-report` (standard for Node.js)

### Installation
```bash
npm install -D license-report
```
*(Install this in the root `electron-app-v4` directory)*

## 2. The Generation Script

Create a script at `electron-app-v4/scripts/generate-licenses.js`. The goal is to scan both the root (backend) and the `renderer` (frontend) directories and merge the results.

### Core Logic
1. **Backend Scanning**: Run `license-report` in the root. Filter for production dependencies.
2. **Frontend Scanning**: Run `license-report` in the `renderer/` folder.
3. **Normalization**:
   - Map fields to a common schema: `name`, `version`, `license`, `author`, `link`, `source`.
   - Identify the source as "Backend" or "Frontend".
4. **Deduplication**: If a library is used in both (e.g., `uuid`), merge or flag it.
5. **Output**: Save to `renderer/public/licenses.json` so the frontend can `fetch` it at runtime.

### Reference Script (`scripts/generate-licenses.js`)
```javascript
const { execSync } = require('child_process');
const { writeFileSync, mkdirSync, existsSync } = require('fs');
const path = require('path');

function getLicenses(dir, sourceLabel) {
    console.log(`Scanning ${sourceLabel} dependencies in ${dir}...`);
    try {
        const cmd = `npx license-report --output=json --only=prod`;
        const output = execSync(cmd, { cwd: dir }).toString();
        return JSON.parse(output).map(dep => ({
            name: dep.name,
            version: dep.installedVersion,
            license: dep.licenseType,
            author: dep.author || 'Unknown',
            link: `https://www.npmjs.com/package/${dep.name}`,
            source: sourceLabel
        }));
    } catch (err) {
        console.error(`Failed to scan ${sourceLabel}:`, err.message);
        return [];
    }
}

// 1. Scan both directories
const backendLicenses = getLicenses('.', 'Backend');
const frontendLicenses = getLicenses('./renderer', 'Frontend');

// 2. Combine and Sort
const combined = [...backendLicenses, ...frontendLicenses].sort((a, b) => 
    a.name.localeCompare(b.name)
);

// 3. Ensure output directory exists
const outDir = path.join(__dirname, '../renderer/public');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// 4. Save
const outPath = path.join(outDir, 'licenses.json');
writeFileSync(outPath, JSON.stringify(combined, null, 2));
console.log(`✅ Generated ${combined.length} licenses at ${outPath}`);
```

## 3. Automation

Add a command to the root `package.json` to ensure the file is updated before builds:
```json
"scripts": {
  "licenses:gen": "node scripts/generate-licenses.js",
  "build:electron": "npm run licenses:gen && npm run build:ui && electron-builder"
}
```

## 4. UI Implementation

### Data Loading
In the Svelte frontend, `fetch` the generated file:
```javascript
let licenses = [];
async function load() {
  const res = await fetch('/licenses.json');
  licenses = await res.json();
}
```

### Features to Include
1. **Total Count**: Show the total number of dependencies (likely 100-300+).
2. **Source Badges**: Use CSS to distinguish "Backend" (Electron/Node) from "Frontend" (Vite/Browser).
3. **External Links**: In Electron, use `window.electron.openExternal(url)` (via preload) to open package pages.
4. **License Categories**: Highlight permissive vs. restrictive licenses if needed.

## 5. Why so many licenses?
Even though this version of CrispLens is "Python-free", it relies on powerful Node.js modules like `onnxruntime-node`, `sharp`, and `better-sqlite3`. These modules themselves have dozens of sub-dependencies. Providing this list ensures legal compliance with MIT/Apache-2.0/BSD requirements for attribution when the software is distributed as a binary.
