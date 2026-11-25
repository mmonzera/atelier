const OPEN_TAG = '<atelier-action>';
const CLOSE_TAG = '</atelier-action>';

/**
 * Stateful streaming filter that suppresses `<atelier-action>...</atelier-action>` blocks
 * before deltas are appended to the live chat bubble, including tags split across chunks.
 */
export function createActionTagStreamFilter(emit: (delta: string) => void): {
  push(delta: string): void;
  flush(): void;
} {
  let buffer = '';
  let insideAction = false;

  const trailingOpenPrefixLen = (text: string): number => {
    const lower = text.toLowerCase();
    const maxLen = Math.min(lower.length, OPEN_TAG.length - 1);
    for (let len = maxLen; len >= 1; len -= 1) {
      if (lower.endsWith(OPEN_TAG.slice(0, len))) {
        return len;
      }
    }
    return 0;
  };

  return {
    push(delta: string) {
      if (!delta) return;
      buffer += delta;

      while (buffer.length > 0) {
        const lower = buffer.toLowerCase();
        if (insideAction) {
          const closeIdx = lower.indexOf(CLOSE_TAG);
          if (closeIdx >= 0) {
            buffer = buffer.slice(closeIdx + CLOSE_TAG.length);
            insideAction = false;
            continue;
          }
          // Keep at most CLOSE_TAG.length - 1 chars in case the closing tag spans chunks.
          if (buffer.length > CLOSE_TAG.length - 1) {
            buffer = buffer.slice(-(CLOSE_TAG.length - 1));
          }
          break;
        }

        const openIdx = lower.indexOf(OPEN_TAG);
        if (openIdx >= 0) {
          if (openIdx > 0) {
            emit(buffer.slice(0, openIdx));
          }
          buffer = buffer.slice(openIdx + OPEN_TAG.length);
          insideAction = true;
          continue;
        }

        const holdLen = trailingOpenPrefixLen(buffer);
        const safeEnd = buffer.length - holdLen;
        if (safeEnd > 0) {
          emit(buffer.slice(0, safeEnd));
          buffer = buffer.slice(safeEnd);
        }
        break;
      }
    },

    flush() {
      if (!insideAction && buffer.length > 0) {
        emit(buffer);
      }
      buffer = '';
      insideAction = false;
    },
  };
}
