// Registers the bot's command menu (setMyCommands) from the command table, and
// sets topic mode (setMySettings).
// Run by the deploy workflow after each Lambda deploy: `npm run telegram:commands`
// with TELEGRAM_BOT_TOKEN in the environment. Prints no secret.
import { applyTopicSettings, registerCommandMenu } from "../src/telegram.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
await registerCommandMenu(token);
console.log("command menu registered");
await applyTopicSettings(token);
console.log("topic mode set");
