import { useCallback, useRef } from 'react';
import { perfTimer } from '../../../utils/debug.js';

interface TextContentCache {
  content: string;
  htmlLength: number;
  timestamp: number;
}

interface UseTextContentOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
}

interface UseTextContentReturn {
  /** Get text content from editable element (with cache optimization) */
  getTextContent: () => string;
  /** Invalidate cache to force fresh content read */
  invalidateCache: () => void;
}

/**
 * useTextContent - Extract plain text from contenteditable element
 *
 * Performance optimization:
 * - Uses cache to avoid repeated DOM traversal
 * - Cache is invalidated when innerHTML length changes
 * - Properly handles file tags by reading data-file-path attribute
 */
export function useTextContent({
  editableRef,
}: UseTextContentOptions): UseTextContentReturn {
  const textCacheRef = useRef<TextContentCache>({
    content: '',
    htmlLength: 0,
    timestamp: 0,
  });

  /**
   * Invalidate cache to force fresh content read
   */
  const invalidateCache = useCallback(() => {
    textCacheRef.current = { content: '', htmlLength: 0, timestamp: 0 };
  }, []);

  /**
   * Get plain text content from editable element
   * Extracts text including file tag references in @path format
   *
   * Performance optimization:
   * - Uses array + join instead of string concatenation (O(n) vs O(n²))
   * - Tracks last character type to avoid repeated string operations
   */
  const getTextContent = useCallback((): string => {
    const timer = perfTimer('getTextContent');
    if (!editableRef.current) return '';

    // Performance optimization: Check cache validity
    const currentHtmlLength = editableRef.current.innerHTML.length;
    const cache = textCacheRef.current;

    // Return cached content if HTML hasn't changed (simple dirty check)
    if (currentHtmlLength === cache.htmlLength && cache.content !== '') {
      timer.mark('cache-hit');
      timer.end();
      return cache.content;
    }
    timer.mark('cache-miss');

    // Extract plain text from DOM, including file tag references
    // Use array + join for O(n) complexity instead of string concatenation O(n²)
    const textParts: string[] = [];
    let endsWithNewline = false;

    // Recursive traversal, but for file-tag only read data-file-path without descending
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const content = node.textContent || '';
        if (content) {
          textParts.push(content);
          endsWithNewline = content.endsWith('\n');
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        const tagName = element.tagName.toLowerCase();

        // Handle line break elements
        if (tagName === 'br') {
          textParts.push('\n');
          endsWithNewline = true;
        } else if (tagName === 'div' || tagName === 'p') {
          // Add newline before div/p (if not first element and doesn't already end with newline)
          if (textParts.length > 0 && !endsWithNewline) {
            textParts.push('\n');
            endsWithNewline = true;
          }
          node.childNodes.forEach(walk);
        } else if (element.classList.contains('file-tag')) {
          const filePath = element.getAttribute('data-file-path') || '';
          // Render file references as clickable markdown links in chat messages.
          // data-file-path examples:
          //   "C:\path\to\file.ts"          — absolute path, no line number
          //   "C:\path\to\file.ts#L10-20"   — with line number info (display format)
          // Output: [@file.ts#L10-20](C:\path\to\file.ts:10-20)
          // The href uses :line format for openFile/parseFileLinkTarget compatibility,
          // while the display text keeps the user-friendly #L format.
          const hashIndex = filePath.indexOf('#');
          if (hashIndex !== -1 && /^#[Ll]\d/.test(filePath.slice(hashIndex))) {
            // Has line number: extract filename + line info, build markdown link
            const purePath = filePath.substring(0, hashIndex);
            const lineInfo = filePath.substring(hashIndex);
            const fileName = purePath.split(/[/\\]/).pop() || purePath;
            // Convert #L10-20 → :10-20 for navigation href
            const lineHref = lineInfo.replace(/^#[Ll]/i, ':');
            textParts.push(`[@${fileName}${lineInfo}](${purePath}${lineHref})`);
          } else {
            // No line number — use simple markdown link with absolute path
            const fileName = filePath.split(/[/\\]/).pop() || filePath;
            const absolutePath = element.getAttribute('data-tooltip') || filePath;
            textParts.push(`[@${fileName}](${absolutePath})`);
          }
          endsWithNewline = false;
          // Don't traverse file-tag children to avoid duplicate filename and close button text
        } else {
          // Continue traversing child nodes
          node.childNodes.forEach(walk);
        }
      }
    };

    editableRef.current.childNodes.forEach(walk);
    timer.mark('dom-walk');

    // Join all parts into final text
    let text = textParts.join('');
    timer.mark('join');

    // Only remove trailing newline that JCEF might add (not user-entered newlines)
    // If there are multiple trailing newlines, only remove the last one (JCEF added)
    if (text.endsWith('\n') && editableRef.current.childNodes.length > 0) {
      const lastChild = editableRef.current.lastChild;
      // Only remove if last node is not a br tag (meaning it's JCEF added)
      if (
        lastChild?.nodeType !== Node.ELEMENT_NODE ||
        (lastChild as HTMLElement).tagName?.toLowerCase() !== 'br'
      ) {
        text = text.slice(0, -1);
      }
    }

    // Update cache
    textCacheRef.current = {
      content: text,
      htmlLength: currentHtmlLength,
      timestamp: Date.now(),
    };

    timer.end();
    return text;
  }, [editableRef]);

  return {
    getTextContent,
    invalidateCache,
  };
}
