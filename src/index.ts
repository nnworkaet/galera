import { loadSettings, getBotToken } from "./config";
import { Router } from "./router";

console.log("===========================================");
console.log("  Claude Topic Router v0.1.0");
console.log("  Telegram topics → Claude Code processes");
console.log("===========================================");

const settings = loadSettings();
const botToken = getBotToken();

console.log(`[Config] Projects root: ${settings.projectsRoot}`);
console.log(`[Config] Max concurrent: ${settings.processes.maxConcurrent}`);
console.log(`[Config] TTL: ${settings.processes.ttlMinutes} min`);
console.log(`[Config] Whisper: ${settings.whisper.enabled ? "ON" : "OFF"}`);

const router = new Router(botToken, settings);
await router.start();
