(function () {
  'use strict';

  /* ================= 工具函数 ================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const HOUR = 3600000;
  const DAY = 86400000;
  const STORAGE_KEY = 'chatgpt-web-clone-v1';
  const THEME_KEY = 'chatgpt-web-clone-theme';

  const escapeHtml = (str = '') =>
    String(str).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));

  const uid = () =>
    window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  const icon = (name, cls = '') =>
    `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

  const md = (...lines) => lines.join('\n');

  /* ================= 状态 ================= */
  const state = {
    chats: [],
    currentId: null,
    streamingId: null,
    stopStream: null,
    model: 'ChatGPT 5',
    theme: 'light',
    search: '',
  };

  const MODELS = [
    { id: 'ChatGPT 5', desc: '适合日常对话与通用任务' },
    { id: 'GPT-4o', desc: '响应更快，支持多模态' },
    { id: 'o3', desc: '擅长复杂推理' },
  ];

  /* ================= DOM ================= */
  const app = $('#app');
  const chatList = $('#chatList');
  const scrollEl = $('#scroll');
  const emptyEl = $('#empty');
  const conversationEl = $('#conversation');
  const input = $('#input');
  const composer = $('#composer');
  const sendBtn = $('#sendBtn');
  const stopBtn = $('#stopBtn');
  const micBtn = $('#micBtn');
  const searchInput = $('#searchInput');
  const modelLabel = $('#modelLabel');
  const toastEl = $('#toast');

  /* ================= Markdown 渲染 ================= */
  function inline(text) {
    let out = escapeHtml(text);
    const codes = [];
    out = out.replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
    );
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
    return out;
  }

  function codeBlock(code, lang) {
    return md(
      '<div class="code-block">',
      '<div class="code-head">',
      `<span class="code-lang">${escapeHtml(lang || '代码')}</span>`,
      `<button type="button" class="code-copy">${icon('copy')}<span>复制</span></button>`,
      '</div>',
      `<pre><code>${escapeHtml(code)}</code></pre>`,
      '</div>'
    );
  }

  const BLOCK_START = /^(```|#{1,6}\s|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*(---+|\*\*\*+)\s*$)/;

  function renderMarkdown(src = '') {
    const lines = String(src).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let listType = null;
    let i = 0;

    const closeList = () => {
      if (listType) {
        html += `</${listType}>`;
        listType = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*$/.test(line)) {
        closeList();
        i++;
        continue;
      }

      if (/^\s*```/.test(line)) {
        closeList();
        const lang = line.trim().slice(3).trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        html += codeBlock(buf.join('\n'), lang);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        html += `<h${level}>${inline(heading[2])}</h${level}>`;
        i++;
        continue;
      }

      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
        closeList();
        html += '<hr>';
        i++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        closeList();
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        html += `<blockquote>${buf.map(inline).join('<br>')}</blockquote>`;
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        if (listType !== 'ul') {
          closeList();
          html += '<ul>';
          listType = 'ul';
        }
        html += `<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`;
        i++;
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        if (listType !== 'ol') {
          closeList();
          html += '<ol>';
          listType = 'ol';
        }
        html += `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`;
        i++;
        continue;
      }

      closeList();
      const buf = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !BLOCK_START.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      html += `<p>${buf.map(inline).join('<br>')}</p>`;
    }

    closeList();
    return html;
  }

  /* ================= 数据初始化 ================= */
  function seedChats() {
    const now = Date.now();
    return [
      {
        id: uid(),
        title: '前端性能优化建议',
        createdAt: now - 2 * HOUR,
        updatedAt: now - 2 * HOUR,
        messages: [
          {
            id: uid(),
            role: 'user',
            content: '我的 React 页面首屏加载有点慢，有哪些优化方向？',
            createdAt: now - 2.1 * HOUR,
          },
          {
            id: uid(),
            role: 'assistant',
            createdAt: now - 2 * HOUR,
            content: md(
              '可以从**网络层、渲染层和代码层**三个方向入手：',
              '',
              '## 1. 网络层',
              '- 开启 Brotli 压缩，静态资源设置长缓存',
              '- 图片使用 WebP / AVIF，非首屏图片加 `loading="lazy"`',
              '- 首屏关键资源使用 preload，第三方脚本尽量延后加载',
              '',
              '## 2. 渲染层',
              '- 用骨架屏占位，避免白屏等待',
              '- 长列表使用虚拟滚动',
              '- 按路由做代码分割：`React.lazy` + `Suspense`',
              '',
              '```jsx',
              'const Detail = React.lazy(() => import("./Detail"));',
              '',
              'export default function App() {',
              '  return (',
              '    <Suspense fallback={<Skeleton />}>',
              '      <Detail />',
              '    </Suspense>',
              '  );',
              '}',
              '```',
              '',
              '## 3. 先度量再优化',
              '用 Lighthouse 和 Web Vitals 定位真实瓶颈，优先解决 LCP 和 INP，不要凭感觉改代码。',
              '',
              '需要我针对你的打包产物列一份具体的排查清单吗？'
            ),
          },
        ],
      },
      {
        id: uid(),
        title: '写作风格润色',
        createdAt: now - 40 * 60000,
        updatedAt: now - 25 * 60000,
        messages: [
          {
            id: uid(),
            role: 'user',
            content: '帮我把这段话改写得更简洁：由于考虑到目前时间较为紧张，我们决定暂时先搁置这个方案。',
            createdAt: now - 30 * 60000,
          },
          {
            id: uid(),
            role: 'assistant',
            createdAt: now - 25 * 60000,
            content: md(
              '可以，给你三个版本：',
              '',
              '1. **简洁版**：时间紧张，我们暂时搁置该方案。',
              '2. **正式版**：鉴于时间有限，我们决定暂缓该方案。',
              '3. **口语版**：现在时间够呛，这个方案先放一放。',
              '',
              '推荐第一个：信息完整，也没有冗余的修饰。'
            ),
          },
        ],
      },
      {
        id: uid(),
        title: 'Python 异步爬虫示例',
        createdAt: now - 1.1 * DAY,
        updatedAt: now - 1.1 * DAY,
        messages: [
          {
            id: uid(),
            role: 'user',
            content: '用 Python 写一个简单的异步爬虫，抓取 10 个页面的标题。',
            createdAt: now - 1.15 * DAY,
          },
          {
            id: uid(),
            role: 'assistant',
            createdAt: now - 1.1 * DAY,
            content: md(
              '基于 `aiohttp` 的并发抓取示例，10 个页面会同时请求：',
              '',
              '```python',
              'import asyncio',
              'import aiohttp',
              'from bs4 import BeautifulSoup',
              '',
              'async def fetch_title(session, url):',
              '    async with session.get(url) as resp:',
              '        html = await resp.text()',
              '        return BeautifulSoup(html, "html.parser").title.text.strip()',
              '',
              'async def main():',
              '    urls = [f"https://example.com/page/{i}" for i in range(10)]',
              '    async with aiohttp.ClientSession() as session:',
              '        titles = await asyncio.gather(*(fetch_title(session, u) for u in urls))',
              '    for t in titles:',
              '        print(t)',
              '',
              'asyncio.run(main())',
              '```',
              '',
              '### 注意点',
              '- `asyncio.gather` 并发执行，总耗时接近最慢的那个请求',
              '- 给客户端设置超时和并发上限，避免压垮目标站点',
              '- 实际项目建议加上重试、UA 和异常处理'
            ),
          },
        ],
      },
      {
        id: uid(),
        title: '周末杭州两日游',
        createdAt: now - 5 * DAY,
        updatedAt: now - 5 * DAY,
        messages: [
          {
            id: uid(),
            role: 'user',
            content: '帮我规划一个周末杭州两日游，轻松一点，不要太赶。',
            createdAt: now - 5.1 * DAY,
          },
          {
            id: uid(),
            role: 'assistant',
            createdAt: now - 5 * DAY,
            content: md(
              '按“每天只安排一个主场景”的思路，给你一条轻松路线：',
              '',
              '## 第一天 · 西湖慢逛',
              '- 上午：断桥 → 白堤 → 孤山，沿湖慢慢走',
              '- 中午：湖滨银泰附近吃饭，顺便休息',
              '- 下午：坐船去三潭印月，或者找个湖边咖啡馆发呆',
              '- 晚上：清河坊小吃，早点回酒店',
              '',
              '## 第二天 · 灵隐与龙井',
              '- 上午：灵隐寺 + 飞来峰（尽量 9 点前到，人少）',
              '- 中午：龙井村附近农家菜',
              '- 下午：茶园散步，然后返程',
              '',
              '> 提示：周末西湖周边堵车明显，优先地铁 + 步行，行程保留弹性。'
            ),
          },
        ],
      },
      {
        id: uid(),
        title: 'SQL 索引为什么失效',
        createdAt: now - 6 * DAY,
        updatedAt: now - 6 * DAY,
        messages: [
          {
            id: uid(),
            role: 'user',
            content: '给字段加了索引，查询还是走了全表扫描，为什么？',
            createdAt: now - 6.05 * DAY,
          },
          {
            id: uid(),
            role: 'assistant',
            createdAt: now - 6 * DAY,
            content: md(
              '常见原因有这几类，可以逐条排查：',
              '',
              '### 1. 对索引列使用了函数或运算',
              '```sql',
              '-- 索引失效',
              'WHERE DATE(created_at) = "2026-10-01"',
              '',
              '-- 改为范围查询',
              'WHERE created_at >= "2026-10-01" AND created_at < "2026-10-02"',
              '```',
              '',
              '### 2. 隐式类型转换',
              '字段是字符串类型，却用数字去比较，会导致索引无法使用。',
              '',
              '### 3. 联合索引不符合最左前缀',
              '索引 `(a, b, c)` 时，只查 `b` 或 `c` 用不上这个索引。',
              '',
              '### 4. 数据区分度太低',
              '如果某个值占了全表绝大部分，优化器会认为全表扫描更划算。',
              '',
              '### 5. 优化器估算偏差',
              '统计信息过期也会导致误判，可以尝试更新统计信息后重新 `EXPLAIN`。',
              '',
              '建议贴一下 `EXPLAIN` 的结果，我可以帮你确认具体是哪一种。'
            ),
          },
        ],
      },
    ];
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && Array.isArray(saved.chats)) {
          state.chats = saved.chats;
          if (typeof saved.model === 'string') state.model = saved.model;
          return;
        }
      }
    } catch (e) {
      /* 忽略损坏的缓存 */
    }
    state.chats = seedChats();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ chats: state.chats, model: state.model }));
    } catch (e) {
      /* 存储不可用时静默失败 */
    }
  }

  /* ================= 侧边栏 ================= */
  function groupLabel(ts) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= start) return '今天';
    if (ts >= start - DAY) return '昨天';
    if (ts >= start - 7 * DAY) return '前 7 天';
    return '更早';
  }

  const GROUP_ORDER = ['今天', '昨天', '前 7 天', '更早'];

  function chatItemHtml(chat) {
    const active = chat.id === state.currentId ? ' active' : '';
    return md(
      `<div class="chat-item${active}" data-id="${chat.id}" role="listitem" tabindex="0">`,
      `<span class="chat-title">${escapeHtml(chat.title)}</span>`,
      `<button type="button" class="chat-more" data-id="${chat.id}" aria-label="更多选项" title="更多选项">${icon('ellipsis')}</button>`,
      '</div>'
    );
  }

  function renderChatList() {
    const query = state.search.trim().toLowerCase();
    const chats = state.chats
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((c) => !query || c.title.toLowerCase().includes(query));

    if (!chats.length) {
      chatList.innerHTML = `<div class="chat-empty">${query ? '没有找到匹配的聊天' : '还没有聊天记录，开始新的对话吧'}</div>`;
      return;
    }

    const groups = new Map();
    chats.forEach((chat) => {
      const label = groupLabel(chat.updatedAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(chat);
    });

    chatList.innerHTML = GROUP_ORDER.filter((label) => groups.has(label))
      .map((label) => md(
        `<div class="chat-group-label">${label}</div>`,
        groups.get(label).map(chatItemHtml).join('')
      ))
      .join('');
  }

  function setMobileSidebar(open) {
    app.classList.toggle('sidebar-open', open);
  }

  function closeMobileSidebar() {
    app.classList.remove('sidebar-open');
  }

  function isMobile() {
    return matchMedia('(max-width: 900px)').matches;
  }

  /* ================= 会话视图 ================= */
  function currentChat() {
    return state.chats.find((c) => c.id === state.currentId) || null;
  }

  function messageHtml(msg) {
    if (msg.role === 'user') {
      return md(
        `<article class="msg user" data-id="${msg.id}">`,
        `<div class="bubble">${escapeHtml(msg.content)}</div>`,
        '</article>'
      );
    }
    const streaming = state.streamingId === msg.id ? ' is-streaming' : '';
    return md(
      `<article class="msg assistant${streaming}" data-id="${msg.id}">`,
      `<div class="md">${renderMarkdown(msg.content)}</div>`,
      `<div class="msg-actions">`,
      `<button type="button" class="msg-btn" data-action="copy" title="复制" aria-label="复制">${icon('copy')}</button>`,
      `<button type="button" class="msg-btn" data-action="like" title="喜欢" aria-label="喜欢">${icon('thumb-up')}</button>`,
      `<button type="button" class="msg-btn" data-action="dislike" title="不喜欢" aria-label="不喜欢">${icon('thumb-down')}</button>`,
      `<button type="button" class="msg-btn" data-action="speak" title="朗读" aria-label="朗读">${icon('speaker')}</button>`,
      `<button type="button" class="msg-btn" data-action="regen" title="重新生成" aria-label="重新生成">${icon('refresh')}</button>`,
      `</div>`,
      '</article>'
    );
  }

  function renderConversation() {
    const chat = currentChat();
    if (!chat) {
      emptyEl.hidden = false;
      conversationEl.hidden = true;
      conversationEl.innerHTML = '';
      document.title = 'ChatGPT';
      return;
    }

    emptyEl.hidden = true;
    conversationEl.hidden = false;
    conversationEl.innerHTML = chat.messages.map(messageHtml).join('');
    document.title = `${chat.title} - ChatGPT`;
    requestAnimationFrame(() => scrollToBottom(false));
  }

  function appendMessageDom(msg) {
    const holder = document.createElement('div');
    holder.innerHTML = messageHtml(msg).trim();
    const node = holder.firstElementChild;
    conversationEl.appendChild(node);
    return node;
  }

  function isNearBottom() {
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 140;
  }

  function scrollToBottom(smooth) {
    scrollEl.scrollTo({
      top: scrollEl.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  /* ================= 发送 / 流式回复 ================= */
  function makeTitle(text) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > 24 ? clean.slice(0, 24) + '…' : clean;
  }

  function generateReply(prompt) {
    const clean = prompt.replace(/[`\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
    const short = clean.length > 42 ? clean.slice(0, 42) + '…' : clean;
    const technical = /(代码|编程|react|vue|python|javascript|typescript|sql|算法|bug|报错|性能|接口|函数|异步)/i.test(clean);

    if (technical) {
      return md(
        `关于「${short}」，下面是一个可以直接执行的排查思路：`,
        '',
        '### 1. 先定位问题',
        '1. 复现问题，并记录最小可复现场景',
        '2. 查看日志与报错堆栈，找到第一个出错的位置',
        '3. 用二分法缩小范围，不要一上来就大面积改代码',
        '',
        '### 2. 一个可复用的重试封装',
        '',
        '```js',
        'async function retry(task, times = 3, delay = 300) {',
        '  for (let i = 0; i < times; i++) {',
        '    try {',
        '      return await task();',
        '    } catch (err) {',
        '      if (i === times - 1) throw err;',
        '      await new Promise((r) => setTimeout(r, delay));',
        '    }',
        '  }',
        '}',
        '```',
        '',
        '### 3. 几点建议',
        '- 先保证正确性，再考虑性能',
        '- 关键路径加监控和埋点，出问题能快速发现',
        '- 改动保持小而可回滚',
        '',
        '> 如果方便的话，把具体报错信息或代码片段发给我，我可以直接帮你定位。'
      );
    }

    return md(
      `关于「${short}」，我建议按这样的节奏推进：`,
      '',
      '## 一、先把目标说清楚',
      '写下你想要的结果、判断标准和时间范围。目标越模糊，执行起来越累。',
      '',
      '## 二、拆成可以验证的小步骤',
      '1. **先做最小版本**，用最低成本验证方向',
      '2. **每步都留记录**，写清楚做了什么、结果如何',
      '3. **定期复盘**，保留有效做法，及时放弃无效尝试',
      '',
      '## 三、几个容易踩的坑',
      '- 一开始就追求完美，导致迟迟没有产出',
      '- 没有明确的验收标准，无法判断是否完成',
      '- 只顾执行，忽略了过程中的反馈',
      '',
      '> 如果能补充更多背景（场景、时间、已有资源），我可以把方案改得更具体。',
      '',
      '需要我先帮你把第一步细化吗？'
    );
  }

  function syncComposer() {
    const streaming = Boolean(state.streamingId);
    const hasText = input.value.trim().length > 0;
    sendBtn.hidden = streaming || !hasText;
    micBtn.hidden = streaming || hasText;
    stopBtn.hidden = !streaming;
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  function streamInto(chat, msg, node, prompt) {
    const mdEl = node.querySelector('.md');
    const full = generateReply(prompt);
    const step = Math.max(2, Math.ceil(full.length / 110));
    let pos = 0;
    let finished = false;
    let timer = null;

    msg.content = '';
    mdEl.innerHTML = '';
    node.classList.add('is-streaming');
    state.streamingId = msg.id;
    syncComposer();

    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (state.streamingId === msg.id) state.streamingId = null;
      state.stopStream = null;
      node.classList.remove('is-streaming');
      mdEl.innerHTML = renderMarkdown(msg.content);
      chat.updatedAt = Date.now();
      syncComposer();
      renderChatList();
      save();
    };

    state.stopStream = finish;

    timer = setInterval(() => {
      if (pos >= full.length) {
        finish();
        return;
      }
      pos = Math.min(full.length, pos + step);
      msg.content = full.slice(0, pos);
      const shouldFollow = isNearBottom();
      mdEl.innerHTML = renderMarkdown(msg.content);
      if (shouldFollow) scrollToBottom(false);
    }, 18);
  }

  function startReply(chat, prompt) {
    const msg = {
      id: uid(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
    };
    chat.messages.push(msg);
    const node = appendMessageDom(msg);
    scrollToBottom(true);
    streamInto(chat, msg, node, prompt);
  }

  function stopStream() {
    if (state.stopStream) state.stopStream();
  }

  function handleSend() {
    if (state.streamingId) return;
    const text = input.value.trim();
    if (!text) return;

    let chat = currentChat();
    if (!chat) {
      chat = {
        id: uid(),
        title: makeTitle(text),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      state.chats.unshift(chat);
      state.currentId = chat.id;
      emptyEl.hidden = true;
      conversationEl.hidden = false;
      conversationEl.innerHTML = '';
    }

    const userMsg = {
      id: uid(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };
    chat.messages.push(userMsg);
    if (chat.messages.filter((m) => m.role === 'user').length === 1) {
      chat.title = makeTitle(text);
    }
    chat.updatedAt = Date.now();

    appendMessageDom(userMsg);

    input.value = '';
    autoGrow();
    syncComposer();
    scrollToBottom(true);
    renderChatList();
    save();
    document.title = `${chat.title} - ChatGPT`;

    startReply(chat, text);
  }

  function regenerate(msgId) {
    if (state.streamingId) return;
    const chat = currentChat();
    if (!chat) return;
    const idx = chat.messages.findIndex((m) => m.id === msgId);
    if (idx < 0 || chat.messages[idx].role !== 'assistant') return;

    const msg = chat.messages[idx];
    const prevUser = chat.messages
      .slice(0, idx)
      .reverse()
      .find((m) => m.role === 'user');
    const node = conversationEl.querySelector(`.msg[data-id="${CSS.escape(msgId)}"]`);
    if (!node) return;

    streamInto(chat, msg, node, prevUser ? prevUser.content : '');
  }

  /* ================= 菜单 / 弹层 ================= */
  let popoverEl = null;
  let popoverAnchor = null;

  function closePopover() {
    if (popoverEl) {
      popoverEl.remove();
      popoverEl = null;
      popoverAnchor = null;
    }
  }

  function positionPopover(pop, anchor, align, placement) {
    pop.style.visibility = 'hidden';
    pop.style.left = '0px';
    pop.style.top = '0px';

    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;

    let left = align === 'right' ? rect.right - width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));

    let top = placement === 'top' ? rect.top - height - 6 : rect.bottom + 6;
    if (placement === 'top' && top < 8) top = rect.bottom + 6;
    if (placement !== 'top' && top + height > window.innerHeight - 8) {
      top = rect.top - height - 6;
    }
    top = Math.max(8, top);

    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.visibility = '';
  }

  function openPopover(anchor, html, opts = {}) {
    if (popoverEl && popoverAnchor === anchor) {
      closePopover();
      return;
    }
    closePopover();

    const pop = document.createElement('div');
    pop.className = 'popover';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = html;
    document.body.appendChild(pop);

    if (opts.width) pop.style.width = opts.width + 'px';
    popoverEl = pop;
    popoverAnchor = anchor;
    positionPopover(pop, anchor, opts.align || 'left', opts.placement || 'bottom');
    requestAnimationFrame(() => pop.classList.add('open'));
  }

  function modelMenuHtml() {
    const items = MODELS.map((m) => {
      const checked = state.model === m.id ? ' checked' : '';
      return md(
        `<button type="button" class="menu-item model-item${checked}" data-model="${m.id}" role="menuitem">`,
        `<span class="model-main">`,
        `<span class="model-id">${m.id}</span>`,
        `<span class="model-desc">${m.desc}</span>`,
        `</span>`,
        state.model === m.id ? icon('check', 'icon-sm') : '',
        '</button>'
      );
    }).join('');
    return `<div class="menu-label">模型</div>${items}`;
  }

  function userMenuHtml() {
    const dark = state.theme === 'dark';
    return md(
      `<div class="menu-head">`,
      `<span class="avatar">L</span>`,
      `<div><div class="menu-name">Linge</div><div class="menu-sub">免费版</div></div>`,
      `</div>`,
      `<button type="button" class="menu-item" data-menu-action="theme" role="menuitem">`,
      icon(dark ? 'sun' : 'moon'),
      `<span>${dark ? '浅色模式' : '深色模式'}</span>`,
      `<span class="switch${dark ? ' on' : ''}" aria-hidden="true"><span></span></span>`,
      `</button>`,
      `<button type="button" class="menu-item" data-menu-action="settings" role="menuitem">`,
      icon('settings'),
      `<span>设置</span>`,
      `</button>`,
      `<hr class="menu-sep">`,
      `<button type="button" class="menu-item" data-menu-action="logout" role="menuitem">`,
      icon('logout'),
      `<span>退出登录</span>`,
      `</button>`
    );
  }

  function chatMenuHtml(id) {
    return md(
      `<button type="button" class="menu-item danger" data-delete="${id}" role="menuitem">`,
      icon('trash'),
      `<span>删除</span>`,
      `</button>`
    );
  }

  function openModelMenu() {
    openPopover($('#modelBtn'), modelMenuHtml(), { width: 280 });
  }

  function openUserMenu(anchor) {
    openPopover(anchor, userMenuHtml(), { width: 240, placement: 'top' });
  }

  function openChatMenu(anchor, id) {
    openPopover(anchor, chatMenuHtml(id), { width: 168, align: 'right' });
  }

  /* ================= 操作 ================= */
  let toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (err) { /* 忽略 */ }
      ta.remove();
    }
    toast('已复制到剪贴板');
  }

  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 忽略 */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#212121' : '#ffffff');
  }

  function setModel(model) {
    if (!MODELS.some((m) => m.id === model)) return;
    state.model = model;
    modelLabel.textContent = model;
    save();
  }

  function newChat() {
    stopStream();
    state.currentId = null;
    state.search = '';
    searchInput.value = '';
    input.value = '';
    autoGrow();
    syncComposer();
    renderChatList();
    renderConversation();
    closeMobileSidebar();
    closePopover();
    input.focus();
  }

  function loadChat(id) {
    const chat = state.chats.find((c) => c.id === id);
    if (!chat) return;
    if (state.currentId !== id) stopStream();
    state.currentId = id;
    renderChatList();
    renderConversation();
    closeMobileSidebar();
    closePopover();
  }

  function deleteChat(id) {
    stopStream();
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.currentId === id) {
      state.currentId = null;
      renderConversation();
    }
    renderChatList();
    save();
    toast('聊天已删除');
  }

  function handleMenuAction(action) {
    if (action === 'theme') {
      setTheme(state.theme === 'dark' ? 'light' : 'dark');
      closePopover();
      return;
    }
    closePopover();
    if (action === 'settings') toast('设置功能为演示内容');
    if (action === 'logout') toast('演示环境，暂不支持退出登录');
  }

  /* ================= 事件绑定 ================= */
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSend();
  });

  input.addEventListener('input', () => {
    autoGrow();
    syncComposer();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handleSend();
    }
  });

  stopBtn.addEventListener('click', () => stopStream());

  $('#newChatBtn').addEventListener('click', newChat);

  $('.brand').addEventListener('click', (e) => {
    e.preventDefault();
    newChat();
  });

  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    renderChatList();
  });

  chatList.addEventListener('click', (e) => {
    const more = e.target.closest('.chat-more');
    if (more) {
      e.stopPropagation();
      openChatMenu(more, more.getAttribute('data-id'));
      return;
    }
    const item = e.target.closest('.chat-item');
    if (item) loadChat(item.getAttribute('data-id'));
  });

  chatList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.chat-item');
    if (!item || e.target.closest('.chat-more')) return;
    e.preventDefault();
    loadChat(item.getAttribute('data-id'));
  });

  conversationEl.addEventListener('click', (e) => {
    const codeCopy = e.target.closest('.code-copy');
    if (codeCopy) {
      const code = codeCopy.closest('.code-block')?.querySelector('code');
      if (!code) return;
      copyText(code.textContent);
      const span = codeCopy.querySelector('span');
      if (span) {
        const old = span.textContent;
        span.textContent = '已复制';
        setTimeout(() => { span.textContent = old; }, 1500);
      }
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const msgEl = btn.closest('.msg');
    const chat = currentChat();
    if (!msgEl || !chat) return;
    const msg = chat.messages.find((m) => m.id === msgEl.getAttribute('data-id'));
    if (!msg) return;

    switch (btn.getAttribute('data-action')) {
      case 'copy':
        copyText(msg.content);
        break;
      case 'like':
      case 'dislike': {
        const wasActive = btn.classList.contains('active');
        const siblings = msgEl.querySelectorAll('[data-action="like"], [data-action="dislike"]');
        siblings.forEach((el) => el.classList.remove('active'));
        if (!wasActive) btn.classList.add('active');
        toast(!wasActive ? '感谢你的反馈' : '已取消反馈');
        break;
      }
      case 'speak':
        toast('朗读功能为演示内容');
        break;
      case 'regen':
        regenerate(msg.id);
        break;
      default:
        break;
    }
  });

  $('#modelBtn').addEventListener('click', () => openModelMenu());
  $('#userBtn').addEventListener('click', () => openUserMenu($('#userBtn')));
  $('#avatarBtn').addEventListener('click', () => openUserMenu($('#avatarBtn')));

  $('#collapseBtn').addEventListener('click', () => {
    if (isMobile()) {
      closeMobileSidebar();
    } else {
      app.classList.add('sidebar-collapsed');
      closePopover();
    }
  });

  $('#topbarToggle').addEventListener('click', () => {
    if (isMobile()) {
      app.classList.toggle('sidebar-open');
    } else {
      app.classList.toggle('sidebar-collapsed');
    }
    closePopover();
  });

  $('#sidebarBackdrop').addEventListener('click', closeMobileSidebar);

  $('#shareBtn').addEventListener('click', async () => {
    if (location.protocol === 'file:') {
      toast('本地演示环境，暂不支持分享链接');
      return;
    }
    try {
      await navigator.clipboard.writeText(location.href);
      toast('链接已复制，可分享给他人');
    } catch (e) {
      toast('复制失败，请手动复制地址栏链接');
    }
  });

  $('#attachBtn').addEventListener('click', () => toast('附件上传为演示内容'));
  $('#toolsBtn').addEventListener('click', () => toast('工具面板为演示内容'));
  $('#micBtn').addEventListener('click', () => toast('语音输入为演示内容'));
  $('#libraryBtn').addEventListener('click', () => toast('资料库为演示内容'));

  document.addEventListener('click', (e) => {
    const modelItem = e.target.closest('[data-model]');
    if (modelItem) {
      setModel(modelItem.getAttribute('data-model'));
      closePopover();
      return;
    }

    const menuAction = e.target.closest('[data-menu-action]');
    if (menuAction) {
      handleMenuAction(menuAction.getAttribute('data-menu-action'));
      return;
    }

    const del = e.target.closest('[data-delete]');
    if (del) {
      deleteChat(del.getAttribute('data-delete'));
      closePopover();
      return;
    }

    if (!popoverEl) return;
    if (e.target.closest('.popover')) return;
    if (popoverAnchor && popoverAnchor.contains(e.target)) return;
    closePopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopover();
      closeMobileSidebar();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      newChat();
    }
  });

  scrollEl.addEventListener('scroll', closePopover, { passive: true });
  window.addEventListener('resize', () => {
    closePopover();
    if (!isMobile()) closeMobileSidebar();
  });

  /* ================= 启动 ================= */
  function init() {
    state.theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    setTheme(state.theme);

    loadState();
    modelLabel.textContent = state.model;

    renderChatList();
    renderConversation();
    syncComposer();
    autoGrow();

    if (!isMobile()) input.focus();
  }

  init();
})();
