#!/usr/bin/env node
import fs from 'fs';
const lines = fs.readFileSync('/home/scott/h2h-arbitrage/data/workspace-cleanup.jsonl', 'utf8').trim().split('\n');
const entries = lines.map(JSON.parse);
const ts = entries.filter(e => e.dryRun).pop().ts;
const block = entries.filter(e => e.ts === ts);
const rm = block.filter(e => e.decision === 'remove-worktree');
const pr = block.filter(e => e.decision === 'prune-caches');
const prot = block.filter(e => e.decision === 'protect');
console.log('latest dryrun ts', ts, 'entries', block.length);
console.log('remove-worktree', rm.length);
rm.forEach(e => console.log(' ', e.candidate, e.taskId, e.reasons.join(','), 'bytes', e.bytesReclaimed));
const reasons = {};
pr.forEach(e => { const k = e.reasons.join(' | '); reasons[k] = (reasons[k] || 0) + 1; });
console.log('prune-caches', pr.length);
Object.entries(reasons).forEach(([k, v]) => console.log(' ', v, k));
console.log('protect', prot.length);
prot.slice(0, 30).forEach(e => console.log(' ', e.candidate, e.taskId, (e.protections || []).join(',')));
