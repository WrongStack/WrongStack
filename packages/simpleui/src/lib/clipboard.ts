export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export async function copyText(
  text: string,
  writer: ClipboardWriter | null | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!text || !writer) return false;
  try {
    await writer.writeText(text);
    return true;
  } catch {
    return false;
  }
}
