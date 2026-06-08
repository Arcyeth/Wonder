/** Minimal leveled logger (stderr) so CLI stdout stays clean for data/JSON. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): number {
  const env = (process.env.LOG_LEVEL || "info").toLowerCase() as Level;
  return LEVELS[env] ?? LEVELS.info;
}

function emit(level: Level, scope: string, msg: string) {
  if (LEVELS[level] < currentLevel()) return;
  const tag = { debug: "·", info: "ℹ", warn: "⚠", error: "✖" }[level];
  process.stderr.write(`${tag} [${scope}] ${msg}\n`);
}

export const log = {
  debug: (scope: string, msg: string) => emit("debug", scope, msg),
  info: (scope: string, msg: string) => emit("info", scope, msg),
  warn: (scope: string, msg: string) => emit("warn", scope, msg),
  error: (scope: string, msg: string) => emit("error", scope, msg),
};
