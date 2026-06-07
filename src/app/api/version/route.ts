import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const ROOT_DIR = path.resolve(process.cwd());
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const CHANGELOG_PATH = path.join(ROOT_DIR, 'CHANGELOG.md');

/** Parse CHANGELOG.md into structured entries */
function parseChangelog(content: string): { version: string; date: string; sections: Record<string, string[]> }[] {
  const entries: { version: string; date: string; sections: Record<string, string[]> }[] = [];
  const lines = content.split('\n');
  
  let currentEntry: { version: string; date: string; sections: Record<string, string[]> } | null = null;
  let currentSection = '';

  for (const line of lines) {
    // Match version header: ## [X.Y.Z] - YYYY-MM-DD or ## [X.Y.Z] (unreleased)
    const versionMatch = line.match(/^## \[(\d+\.\d+\.\d+)\]\s*-?\s*(.+)?$/);
    if (versionMatch) {
      if (currentEntry) {
        entries.push(currentEntry);
      }
      const [, version, datePart] = versionMatch;
      const date = datePart?.trim() || '';
      currentEntry = { version, date: date.startsWith('(') ? '' : date, sections: {} };
      currentSection = '';
      continue;
    }

    // Match section header: ### Added, ### Fixed, etc.
    const sectionMatch = line.match(/^### (.+)/);
    if (sectionMatch && currentEntry) {
      currentSection = sectionMatch[1].trim();
      currentEntry.sections[currentSection] = [];
      continue;
    }

    // Collect bullet points
    const bulletMatch = line.match(/^\s*-\s+(.+)/);
    if (bulletMatch && currentEntry && currentSection) {
      currentEntry.sections[currentSection].push(bulletMatch[1].trim());
    }
  }

  if (currentEntry) {
    entries.push(currentEntry);
  }

  return entries;
}

/* ╔═══════════════════════════════════════════════════════════════╗
   GET /api/version
   Return current app version from package.json.
   
   Response: { "version": "0.1.0" }
   ╚═══════════════════════════════════════════════════════════════╝ */
export async function GET() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    return NextResponse.json({ version: pkg.version });
  } catch {
    return NextResponse.json({ version: 'unknown' }, { status: 200 });
  }
}

/* ╔═══════════════════════════════════════════════════════════════╗
   GET /api/changelog
   Return parsed changelog entries.
   
   Response: {
     "entries": [
       {
         "version": "0.2.0",
         "date": "2025-06-07",
         "sections": {
           "Added": [...],
           "Fixed": [...]
         }
       }
     ]
   }
   ╚═══════════════════════════════════════════════════════════════╝ */
export async function getChangelogRoute() {
  try {
    const content = fs.readFileSync(CHANGELOG_PATH, 'utf8');
    const entries = parseChangelog(content);
    return NextResponse.json({ entries });
  } catch {
    return NextResponse.json({ entries: [] }, { status: 200 });
  }
}
