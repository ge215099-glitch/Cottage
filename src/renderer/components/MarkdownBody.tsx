/**
 * 消息正文的 Markdown 渲染（技术方案 9.5）。
 *
 * **消毒是必须项，不是可选项**：模型输出是外部输入，可能含脚本或外链图片。
 * `rehype-sanitize` 配合主进程下发的 CSP（`img-src 'self' data:`、
 * `script-src 'self'`）形成双保险。
 *
 * 代码高亮与数学公式属于二期（体积与复杂度都不值），MVP 只保证代码块可读。
 */
import { memo } from 'react';
import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

export interface MarkdownBodyProps {
  content: string;
}

/**
 * 允许的标签白名单。
 *
 * 显式列出而不是用默认 schema：默认值在不同版本间会变，
 * 而"模型输出能渲染出什么"属于安全边界，必须由我们钉死。
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
];

/**
 * 允许的属性白名单。
 *
 * 刻意**不含 `img`**：MVP 不做图片输入输出，允许图片就等于允许模型往界面里塞
 * 任意外链（隐私与追踪面）。`a` 只留 href/title，且点击交给主进程决定是否外开。
 */
const SANITIZE_SCHEMA = {
  tagNames: ALLOWED_TAGS,
  attributes: {
    a: ['href', 'title'],
    code: ['className'],
    span: ['className'],
    td: ['align'],
    th: ['align'],
  },
  protocols: {
    href: ['http', 'https', 'mailto'],
  },
};

function MarkdownBodyInner({ content }: MarkdownBodyProps): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}
        components={{
          // 链接不在应用窗口内打开：交给主进程用系统浏览器打开（见 window.ts）
          a: ({ href, children }) => (
            <a href={href} rel="noreferrer noopener" target="_blank">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownBody = memo(MarkdownBodyInner);
