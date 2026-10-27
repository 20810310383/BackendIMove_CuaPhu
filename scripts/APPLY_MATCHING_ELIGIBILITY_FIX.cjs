/* TH79 iMove — surgical installer: approves service matching and GPS priority.
 * Backup before modification; abort on unknown source layout. Idempotent.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const wantApply = process.argv.includes('--apply');
const files = [
  { filename: 'src/matching_policy.js', substitutions: [
    {
      label: 'Null GPS coordinates must not score as zero kilometers',
      before: "  const distance = Number(candidate.distanceKm);\n  const distanceScore = Number.isFinite(distance)",
      after: "  // Null/undefined means unknown location, NEVER 0 km.\n  const distance = candidate.distanceKm == null ? NaN : Number(candidate.distanceKm);\n  const distanceScore = Number.isFinite(distance)",
    },
    {
      label: 'Rank GPS-verified candidates before no-GPS fallbacks',
      before: "  }).sort((a, b) => {\n    if (b.matchingScore !== a.matchingScore) return b.matchingScore - a.matchingScore;\n    const da = Number.isFinite(Number(a.distanceKm)) ? Number(a.distanceKm) : Infinity;\n    const dbb = Number.isFinite(Number(b.distanceKm)) ? Number(b.distanceKm) : Infinity;",
      after: "  }).sort((a, b) => {\n    // A GPS-less fallback must never outrank a valid GPS candidate.\n    const aHasGps = a.distanceKm != null && Number.isFinite(Number(a.distanceKm));\n    const bHasGps = b.distanceKm != null && Number.isFinite(Number(b.distanceKm));\n    if (aHasGps !== bHasGps) return aHasGps ? -1 : 1;\n    if (b.matchingScore !== a.matchingScore) return b.matchingScore - a.matchingScore;\n    const da = aHasGps ? Number(a.distanceKm) : Infinity;\n    const dbb = bHasGps ? Number(b.distanceKm) : Infinity;",
    },
  ]},
  { filename: 'src/matching_engine.js', substitutions: [
    {
      label: 'Match vehicle services approved in the KYC workflow',
      before: "    if (serviceCode) vehicleQuery.$or = [{ serviceCodes: String(serviceCode).toUpperCase() }, { serviceCode: String(serviceCode).toUpperCase() }];",
      after: "    if (serviceCode) {\n      const code = String(serviceCode).toUpperCase();\n      vehicleQuery.$or = [\n        { approvedServiceCodes: code },\n        { serviceCodes: code },\n        { serviceCode: code },\n      ];\n    }",
    },
    {
      label: 'Preserve null distance in V6.9 candidate previews',
      before: "          distanceKm: Number.isFinite(Number(candidate.distanceKm)) ? Number(candidate.distanceKm) : null,",
      after: "          distanceKm: candidate.distanceKm != null && Number.isFinite(Number(candidate.distanceKm)) ? Number(candidate.distanceKm) : null,",
    },
  ]},
];
let operations=[];let errors=[];
for (const {filename,substitutions} of files) {
  const file = path.join(root, filename);
  if (!fs.existsSync(file)) { errors.push(`Missing ${filename}`); continue; }
  const original=fs.readFileSync(file,'utf8');
  const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
  let output=original.replace(/\r\n/g,'\n'), changed=0;
  for (const s of substitutions) {
    const haveBefore=output.includes(s.before);
    const haveAfter=output.includes(s.after);
    if (haveAfter) { console.log(`[READY] ${filename}: ${s.label}`);continue; }
    if (!haveBefore) { errors.push(`Unknown source; cannot patch ${filename}: ${s.label}`); continue; }
    output=output.replace(s.before,s.after);changed++;
    console.log(`[PATCH] ${filename}: ${s.label}`);
  }
  operations.push({file,filename,original,output:lineEnding==='\r\n'?output.replace(/\n/g,'\r\n'):output,changed});
}
if(errors.length){for(const x of errors)console.error('[ERROR]',x);process.exitCode=2;}
else if (!wantApply) console.log('CHECK OK — run node scripts/APPLY_MATCHING_ELIGIBILITY_FIX.cjs --apply to install.');
else {
  const label=new Date().toISOString().replace(/[:.]/g,'-');
  for(const f of operations)if(f.changed){
    fs.copyFileSync(f.file,`${f.file}.backup-${label}`);
    fs.writeFileSync(f.file,f.output);
    console.log(`[UPDATED] ${f.filename}; backup written`);
  }
  console.log('APPLY OK. Run node --check on both files and restart staging ONLY after tests.');
}
