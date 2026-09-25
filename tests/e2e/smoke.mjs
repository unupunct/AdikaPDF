import { launchApp } from './harness.mjs';
const app = await launchApp();
const info = await app.page.evaluate(() => ({ title: document.title, welcome: !!document.querySelector('[data-testid="welcome"]'), ua: navigator.userAgent, hooks: Object.keys(window.__adika) }));
console.log(JSON.stringify(info, null, 1));
await app.page.screenshot({ path: process.argv[2] });
await app.close();
