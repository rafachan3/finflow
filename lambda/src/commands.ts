/**
 * The bot's slash commands: name -> what the Telegram menu shows. The handler
 * routes on these keys (its run table must cover each one), and the deploy
 * workflow registers the same table as the command menu.
 */
export const COMMANDS = {
  pending: "Resend cards still waiting for Confirm",
} as const;

export type CommandName = keyof typeof COMMANDS;

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
