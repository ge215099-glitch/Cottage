// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageItem } from '../../src/renderer/components/MessageItem.js';
import { makeMessage } from './helpers.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function message(content: string, streaming = true, bilingual = false) {
  return <MessageItem message={makeMessage({ role: 'assistant', content, status: streaming ? 'streaming' : 'done' })} characterName="角色" showMetaAlways={false} streaming={streaming} bilingual={bilingual}/>;
}

describe('流式消息展示', () => {
  it('等待首字时显示状态，正文逐渐出现且完整保留 Markdown 和中文符号', () => {
    const view = render(message(''));
    expect(screen.getByRole('status', { name: '正在生成回复' })).toBeTruthy();
    const content = '**雨后**的书店里，灯还亮着。🌧️她把一本书轻轻放在桌上。';
    view.rerender(message(content));
    act(() => vi.advanceTimersByTime(50));
    expect(screen.queryByRole('status')).toBeNull();
    const partial = view.container.querySelector('.md')!.textContent!;
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(content.replaceAll('**', '').length);
    act(() => vi.advanceTimersByTime(1000));
    expect(view.container.querySelector('.md')!.textContent).toBe(content.replaceAll('**', ''));
    expect(view.container.querySelector('strong')!.textContent).toBe('雨后');
  });

  it('连续快速分片不会饿死展示，停止时立即显示全部内容并取消延迟更新', () => {
    const view = render(message(''));
    let content = '';
    for (let i = 0; i < 20; i++) {
      content += '新的内容';
      view.rerender(message(content));
      act(() => vi.advanceTimersByTime(24));
    }
    expect(view.container.querySelector('.md')!.textContent!.length).toBeGreaterThan(0);
    view.rerender(message(content, false));
    expect(view.container.querySelector('.md')!.textContent).toBe(content);
    act(() => vi.advanceTimersByTime(1000));
    expect(view.container.querySelector('.md')!.textContent).toBe(content);
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull();
  });

  it('减少动态效果时直接显示收到的文本，替换或清空回复不会显示旧内容', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const view = render(message(''));
    view.rerender(message('第一段🌳'));
    expect(view.container.querySelector('.md')!.textContent).toBe('第一段🌳');
    view.rerender(message(''));
    expect(screen.getByRole('status')).toBeTruthy();
    view.rerender(message('重新生成'));
    expect(view.container.querySelector('.md')!.textContent).toBe('重新生成');
  });

  it('双语回复每组保留英中换行，空行分隔各组', () => {
    const firstGroup = 'The gate creaked. Robin stepped inside.\n大门吱呀一声。Robin 走了进去。';
    const secondGroup = 'Wait here. I will be back soon.\n在这里等我。我很快回来。';
    const view = render(message(firstGroup, true, true));
    view.rerender(message(`${firstGroup}\n\n${secondGroup}`, true, true));
    act(() => vi.advanceTimersByTime(1000));
    const groups = () => [...view.container.querySelectorAll('.bilingual-lines > p')].map((paragraph) => paragraph.textContent);
    expect(groups()).toEqual([firstGroup, secondGroup]);
    view.rerender(message(`${firstGroup}\n\n${secondGroup}`, false, true));
    expect(groups()).toEqual([firstGroup, secondGroup]);
  });
});
