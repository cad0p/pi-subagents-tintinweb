/**
 * text-safety.ts — shared sanitizer for untrusted text that reaches the
 * terminal or the model context (child output, tool arguments, settings).
 */

/**
 * Strip terminal control sequences and invisible/forging characters, keeping
 * tab, LF, and printable non-ASCII. Complete OSC/CSI sequences are consumed
 * whole; a dangling introducer goes with its ESC/C1 byte, while an
 * unterminated payload (an OSC/DCS sequence missing its terminator) may leave
 * that payload as visible text. CR is dropped, so CRLF collapses to LF and a
 * lone CR cannot overwrite the rendered line. A guard against terminal control
 * and invisible text, not a content filter: markdown and XML-ish characters
 * pass through untouched.
 *
 * The invisible/format set includes the Unicode Tag block (U+E0001,
 * U+E0020–U+E007F), which encodes invisible ASCII payloads, plus CGJ, Hangul
 * fillers, and the variation-selector supplement. U+FE0E/U+FE0F are
 * deliberately kept: they carry emoji vs text presentation.
 */
export function stripControlChars(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // complete OSC: ESC ] … BEL | ST
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "") // complete CSI: ESC [ … final byte
    .replace(/[\u001b\u009b][[\]()#;?]*/g, "") // dangling ESC/C1 plus its introducer
    .replace(
      /[\u{e0100}-\u{e01ef}\u034f\x00-\x08\x0b-\x0d\x0e-\x1f\x7f-\x9f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\u3164\ufeff\uffa0\u{e0001}\u{e0020}-\u{e007f}]/gu,
      "",
    );
}
