/**
 * Exact recovery evidence is separate from the deliberately lossy auto-name draft.
 * Only append-only text, LF newlines and bracketed LF paste are modeled. Cursor
 * edits, history, completion and oversized drafts supply no submission evidence.
 */
export interface CodexInputProof {
  prompts: Array<string | undefined>;
  invalidated: boolean;
}

const MAX_PROMPT_BYTES = 8_192;
const MAX_SEQUENCE_LENGTH = 64;

export class CodexInputProofTracker {
  private draft = '';
  private bytes = 0;
  private tainted = false;
  private sequence = '';
  private inPaste = false;

  /** Input delivered outside this model cannot be used to reconstruct a draft. */
  invalidate(): void {
    this.draft = '';
    this.bytes = 0;
    this.sequence = '';
    this.inPaste = false;
    this.tainted = true;
  }

  feed(data: string): CodexInputProof {
    const result: CodexInputProof = { prompts: [], invalidated: false };
    const taint = () => {
      this.draft = '';
      this.bytes = 0;
      this.tainted = true;
      result.invalidated = true;
    };
    for (const ch of data) {
      if (this.sequence) {
        this.sequence += ch;
        // Accept only the two paste markers, including markers split across frames.
        if (['\x1b[200~', '\x1b[201~'].some((marker) => marker.startsWith(this.sequence))) {
          if (this.sequence === '\x1b[200~') {
            if (this.inPaste) taint();
            this.inPaste = true;
            this.sequence = '';
          } else if (this.sequence === '\x1b[201~') {
            if (!this.inPaste) taint();
            this.inPaste = false;
            this.sequence = '';
          }
          continue;
        }
        taint();
        if (this.sequence.length >= MAX_SEQUENCE_LENGTH || /[\x40-\x7e]$/.test(ch)) this.sequence = '';
        continue;
      }
      if (ch === '\x1b') {
        this.sequence = ch;
        // ESC itself may be an editor command. A supported paste marker may
        // complete next; defer invalidation only while that marker is possible.
        continue;
      }
      if (ch === '\r' && !this.inPaste) {
        result.prompts.push(this.tainted || !this.draft.trim() ? undefined : this.draft);
        this.draft = '';
        this.bytes = 0;
        this.tainted = false;
        continue;
      }
      const point = ch.codePointAt(0) ?? 0;
      if ((point >= 0xd800 && point <= 0xdfff) || (ch !== '\n' && (point < 0x20 || point === 0x7f))) {
        // CR/CRLF inside paste may be normalized by the TUI: never guess.
        // A surrogate split across writes is encoded separately by the PTY.
        taint();
        continue;
      }
      if (!this.tainted) {
        this.bytes += Buffer.byteLength(ch, 'utf8');
        if (this.bytes > MAX_PROMPT_BYTES) taint();
        else this.draft += ch;
      }
    }
    // A bare Escape is not trusted input. Split CSI paste markers remain pending;
    // none can yield a prompt until its framing is complete.
    if (this.sequence === '\x1b') {
      this.sequence = '';
      taint();
    } else if (this.sequence) result.invalidated = true;
    return result;
  }
}
