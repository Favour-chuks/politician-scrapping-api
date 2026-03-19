// import { startRssMonitor } from './services/RssMonitor.js';
// startRssMonitor()

import { main } from "./services/GeminiService.js";
main().catch((e) => {
  console.error("Fatal error in GeminiService:", e);
  process.exit(1);
});