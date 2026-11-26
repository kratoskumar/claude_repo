// Playwright is pre-installed globally; CommonJS require() finds it through NODE_PATH.
import { createRequire } from 'node:module';
export const { chromium, devices } = createRequire(import.meta.url)('playwright');
