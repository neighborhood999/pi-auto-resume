/** Write one terminal bell without coupling application logic to stdout. */
export type TerminalBellWriter = (text: string) => void;

/**
 * Create the terminal-bell adapter used after a successful resumed turn.
 *
 * @param write - Output sink, injectable so tests never emit BEL.
 * @returns A side-effecting bell function.
 */
export function createTerminalBell(write: TerminalBellWriter = writeStdout): () => void {
  return () => write('\u0007');
}

function writeStdout(text: string): void {
  process.stdout.write(text);
}
