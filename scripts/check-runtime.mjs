import { requireSupportedNode } from './runtime.mjs';

if (!requireSupportedNode()) process.exitCode = 1;
