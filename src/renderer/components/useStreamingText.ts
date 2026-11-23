import { useEffect, useRef, useState } from 'react';

/** Smooth only the visible text; the store always retains every received character. */
export function useStreamingText(content: string, streaming: boolean): string {
  const [visible, setVisible] = useState(content);
  const shown = useRef(content);
  const last = useRef(performance.now());

  useEffect(() => {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const flush = () => {
      cancelAnimationFrame(frame);
      shown.current = content;
      setVisible(content);
    };
    if (!streaming || motion?.matches || !content.startsWith(shown.current)) {
      flush();
      return;
    }

    last.current = Math.max(last.current, performance.now() - 1000 / 30);
    const reveal = (now: number) => {
      const elapsed = now - last.current;
      if (elapsed >= 1000 / 30) {
        // Catch up with large chunks quickly, without splitting a Unicode code point.
        const pending = Array.from(content.slice(shown.current.length));
        const count = Math.max(1, Math.ceil(pending.length * Math.min(elapsed / 120, 1)));
        shown.current += pending.slice(0, count).join('');
        setVisible(shown.current);
        last.current = now;
      }
      if (shown.current.length < content.length) frame = requestAnimationFrame(reveal);
    };
    if (shown.current.length < content.length) frame = requestAnimationFrame(reveal);
    const onMotionChange = () => { if (motion?.matches) flush(); };
    motion?.addEventListener('change', onMotionChange);
    return () => {
      cancelAnimationFrame(frame);
      motion?.removeEventListener('change', onMotionChange);
    };
  }, [content, streaming]);

  // Final, stopped and replaced messages appear in full immediately.
  return streaming && content.startsWith(visible) ? visible : content;
}
