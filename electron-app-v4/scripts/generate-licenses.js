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
