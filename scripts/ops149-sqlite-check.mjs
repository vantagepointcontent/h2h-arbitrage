#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/home/scott/.hermes/kanban/boards/h2h-arbitrage/kanban.db');
console.log('kanban integrity:', db.prepare('PRAGMA integrity_check').get());
db.close();
