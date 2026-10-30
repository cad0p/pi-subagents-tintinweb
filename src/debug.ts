/** Diagnostic run-cap lines, off unless PI_SUBAGENTS_DEBUG is set. The channel exists to answer
 *  #112 item 4 (does the parent's request after a capped child still hit a warm cache?). */
export function capDebugEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PI_SUBAGENTS_DEBUG ?? "");
}
