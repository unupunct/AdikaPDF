import type { MarkupKind, ToolId } from '@/types';

/** Tools that work on the text layer (select text, text markup). */
export function isTextTool(tool: ToolId): boolean {
  return tool === 'selectText' || tool.startsWith('markup-');
}

export function markupKindOf(tool: ToolId): MarkupKind | null {
  return tool.startsWith('markup-') ? (tool.slice(7) as MarkupKind) : null;
}
