/**
 * The bot's slash commands: name -> what the Telegram menu shows. The handler
 * routes on these keys (its run table must cover each one), and the deploy
 * workflow registers the same table as the command menu.
 */
export const COMMANDS = {
  pending: "Resend cards still waiting for Confirm",
  merchants: "List merchants",
  addmerchant: "Add a merchant: /addmerchant Name",
  delmerchant: "Delete a merchant: /delmerchant Name",
} as const;

export type CommandName = keyof typeof COMMANDS;

/** The setMyCommands payload for the table. */
export function commandMenu(): { command: string; description: string }[] {
  return Object.entries(COMMANDS).map(([command, description]) => ({ command, description }));
}

// Telegram appends @botname to a command in a group or when it is picked from the menu.
const COMMAND = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/;

/** A known command in the text, with its trimmed argument; anything else is not a command. */
export function parseCommand(
  text: string | undefined,
): { name: CommandName; args: string } | null {
  const m = COMMAND.exec(text?.trim() ?? "");
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!Object.hasOwn(COMMANDS, name)) return null;
  return { name: name as CommandName, args: (m[2] ?? "").trim() };
}

export const DELETE_USAGE = "Send /delmerchant Name";

const TELEGRAM_TEXT_MAX = 4096;
const MERCHANT_NAME_MAX = 100;

export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function formatMerchants(names: string[]): string {
  if (names.length === 0) return "No merchants.";
  const text = `Merchants (${names.length}): ${names.join(", ")}`;
  return text.length > TELEGRAM_TEXT_MAX ? `${text.slice(0, TELEGRAM_TEXT_MAX - 1)}…` : text;
}

/** The name to add, or why not. A comma would split one merchant into two in the prompt's list. */
export function cleanMerchantName(raw: string): { name: string } | { error: string } {
  const name = collapseSpaces(raw);
  if (name === "") return { error: "Send /addmerchant Name" };
  if (name.length > MERCHANT_NAME_MAX) {
    return { error: `A merchant name is at most ${MERCHANT_NAME_MAX} characters.` };
  }
  if (name.includes(",")) return { error: "A merchant name can't contain a comma." };
  return { name };
}

export function addReply(result: { added: string } | { exists: string }): string {
  return "added" in result
    ? `Added merchant: ${result.added}. The next message will use it.`
    : `Already a merchant: ${result.exists}.`;
}

export function deleteReply(
  result: { deleted: string } | { missing: true } | { inUse: number; name: string },
  typed: string,
): string {
  if ("deleted" in result) return `Deleted merchant: ${result.deleted}.`;
  if ("missing" in result) return `No merchant named ${typed}. Send /merchants for the list.`;
  const s = result.inUse === 1 ? "" : "s";
  return `${result.name} is on ${result.inUse} saved transaction${s}, so it stays.`;
}
