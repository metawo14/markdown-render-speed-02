// main.ts — driver for the markdown-render-speed-02 entry.
// Reads every case from $MAKEFUN_INPUT_DIR/cases.json (default /input),
// renders each one with parse() from parse.js, and writes
// $MAKEFUN_OUTPUT_DIR/html.json (a JSON array of the HTML strings, in order).
// Only Node built-ins are used. Runs as `node /bot/main.ts` on Node 22.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
