/**
 * 提交说明的 Markdown 解析与渲染模块。
 * 分块规则取自 VS Code Git 扩展的 formatCommitMessage：每行各自成块，空行只表示段落间隔，围栏代码块与缩进代码块整体保留；
 * 与 VS Code 一样不解析 HTML 标签与图片语法，按原文显示。链接只保留 http、https、mailto 三种协议。
 * 解析为纯数据（可在 Node.js 下测试），渲染只创建 DOM 节点、不拼接 HTML 字符串。
 */

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const RULE_PATTERN = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_PATTERN = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const QUOTE_PATTERN = /^ {0,3}>[ \t]?(.*)$/;
const LIST_ITEM_PATTERN = /^( *)([-*+]|(\d{1,9})[.)])(?:[ \t]+(.*))?$/;
const INDENTED_CODE_COLUMNS = 4;
const ASCII_PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const SAFE_LINK_PATTERN = /^(?:https?:\/\/|mailto:)/i;
// 裸链接只吃 ASCII 可见字符：中文提交说明里网址后常紧跟全角标点，不能并入链接
const BARE_URL_PATTERN = /^(?:https?:\/\/|www\.)[\x21-\x3b\x3d\x3f-\x7e]+/i;
const BARE_URL_TRAILING_PUNCTUATION = '?!.,:;*_~\'"';
const AUTOLINK_PATTERN = /^<((?:https?:\/\/|mailto:)[^\s<>]+|[^\s<>@]+@[^\s<>]+)>/i;

/**
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'code', text: string }
 *   | { type: 'strong' | 'em' | 'del', children: InlineNode[] }
 *   | { type: 'link', href: string, children: InlineNode[] }} InlineNode
 * @typedef {{ inlines: InlineNode[], blocks: BlockNode[], spaced: boolean }} ListItem
 * @typedef {{ type: 'paragraph' | 'quote', inlines: InlineNode[], spaced: boolean }
 *   | { type: 'heading', level: number, inlines: InlineNode[], spaced: boolean }
 *   | { type: 'rule', spaced: boolean }
 *   | { type: 'code', text: string, spaced: boolean }
 *   | { type: 'list', ordered: boolean, start: number, items: ListItem[], spaced: boolean }} BlockNode
 */

const expandTabs = (line) => line.replace(/^[ \t]+/, (lead) => lead.replaceAll('\t', ' '.repeat(INDENTED_CODE_COLUMNS)));

const leadingSpaces = (line) => line.length - line.trimStart().length;

const pushText = (nodes, text) => {
  if (!text) return;
  const last = nodes.at(-1);
  if (last?.type === 'text') {
    last.text += text;
  } else {
    nodes.push({ type: 'text', text });
  }
};

const isWordChar = (char) => Boolean(char) && /[\p{L}\p{N}]/u.test(char);

const findCodeSpanEnd = (text, start, runLength) => {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] !== '`') continue;
    let end = index;
    while (text[end] === '`') end += 1;
    if (end - index === runLength) return index;
    index = end - 1;
  }
  return -1;
};

const findLinkLabelEnd = (text, start) => {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
};

const parseLinkDestination = (text, start) => {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      if (depth === 0) {
        const inner = text.slice(start, index).trim();
        const href = /^(\S+)(?:\s+(?:"[^"]*"|'[^']*'))?$/.exec(inner)?.[1] ?? null;
        return href === null ? null : { href: href.replace(/^<(.*)>$/, '$1'), end: index + 1 };
      }
      depth -= 1;
    }
  }
  return null;
};

const trimBareUrl = (url) => {
  let trimmed = url;
  for (;;) {
    const last = trimmed.at(-1);
    if (BARE_URL_TRAILING_PUNCTUATION.includes(last)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    if (last === ')' && trimmed.split(')').length > trimmed.split('(').length) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    return trimmed;
  }
};

const EMPHASIS_RULES = [
  { type: 'strong', pattern: /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/ },
  { type: 'del', pattern: /^~~(?=\S)([\s\S]*?\S)~~/ },
  { type: 'em', pattern: /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/ },
  { type: 'em', pattern: /^_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}])/u },
];

/**
 * 解析单行文本中的行内 Markdown（代码、粗体、斜体、删除线、链接与裸链接）。
 *
 * @param {string} text 单行文本
 * @returns {InlineNode[]} 行内节点列表（无副作用）
 */
export const parseInlineMarkdown = (text) => {
  const nodes = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    const rest = text.slice(index);

    if (char === '\\' && ASCII_PUNCTUATION.includes(text[index + 1] ?? '')) {
      pushText(nodes, text[index + 1]);
      index += 2;
      continue;
    }

    if (char === '`') {
      let runEnd = index;
      while (text[runEnd] === '`') runEnd += 1;
      const runLength = runEnd - index;
      const closeIndex = findCodeSpanEnd(text, runEnd, runLength);
      if (closeIndex === -1) {
        pushText(nodes, text.slice(index, runEnd));
        index = runEnd;
        continue;
      }
      const raw = text.slice(runEnd, closeIndex);
      const stripped = raw.length > 1 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim() ? raw.slice(1, -1) : raw;
      nodes.push({ type: 'code', text: stripped });
      index = closeIndex + runLength;
      continue;
    }

    if (char === '<') {
      const autolink = AUTOLINK_PATTERN.exec(rest);
      if (autolink) {
        const target = autolink[1];
        const href = SAFE_LINK_PATTERN.test(target) ? target : `mailto:${target}`;
        nodes.push({ type: 'link', href, children: [{ type: 'text', text: target }] });
        index += autolink[0].length;
        continue;
      }
    }

    // 与 VS Code 一致，图片语法按原文显示
    if (char === '!' && text[index + 1] === '[') {
      pushText(nodes, '![');
      index += 2;
      continue;
    }

    if (char === '[') {
      const labelEnd = findLinkLabelEnd(text, index + 1);
      const destination = labelEnd !== -1 && text[labelEnd + 1] === '('
        ? parseLinkDestination(text, labelEnd + 2)
        : null;
      if (destination) {
        const children = parseInlineMarkdown(text.slice(index + 1, labelEnd));
        if (SAFE_LINK_PATTERN.test(destination.href)) {
          nodes.push({ type: 'link', href: destination.href, children });
        } else {
          for (const child of children) {
            if (child.type === 'text') pushText(nodes, child.text);
            else nodes.push(child);
          }
        }
        index = destination.end;
        continue;
      }
    }

    if (char === '*' || char === '_' || char === '~') {
      // 下划线只在词边界生效，避免 snake_case 标识符被当成斜体
      const rule = char === '_' && isWordChar(text[index - 1])
        ? null
        : EMPHASIS_RULES.find((candidate) => candidate.pattern.test(rest));
      if (rule) {
        const match = rule.pattern.exec(rest);
        const inner = match.length > 2 ? match[2] : match[1];
        nodes.push({ type: rule.type, children: parseInlineMarkdown(inner) });
        index += match[0].length;
        continue;
      }
    }

    if ((char === 'h' || char === 'H' || char === 'w' || char === 'W') && !isWordChar(text[index - 1])) {
      const bareUrl = BARE_URL_PATTERN.exec(rest);
      if (bareUrl) {
        const url = trimBareUrl(bareUrl[0]);
        const href = /^www\./i.test(url) ? `http://${url}` : url;
        nodes.push({ type: 'link', href, children: [{ type: 'text', text: url }] });
        index += url.length;
        continue;
      }
    }

    pushText(nodes, char);
    index += 1;
  }

  return nodes;
};

const parseLineBlock = (line, spaced) => {
  if (RULE_PATTERN.test(line)) {
    return { type: 'rule', spaced };
  }
  const heading = HEADING_PATTERN.exec(line);
  if (heading) {
    return { type: 'heading', level: heading[1].length, inlines: parseInlineMarkdown(heading[2] ?? ''), spaced };
  }
  const quote = QUOTE_PATTERN.exec(line);
  if (quote) {
    return { type: 'quote', inlines: parseInlineMarkdown(quote[1]), spaced };
  }
  return { type: 'paragraph', inlines: parseInlineMarkdown(line.trim()), spaced };
};

/**
 * 按 VS Code 提交悬浮卡的规则把提交说明解析为块级节点。
 *
 * @param {string} message 完整提交说明（标题行 + 正文）
 * @returns {BlockNode[]} 块级节点列表；`spaced` 表示该块前有空行（无副作用）
 */
export const parseCommitMarkdown = (message) => {
  const lines = message.split(/\r\n|\r|\n/).map(expandTabs);
  const blocks = [];
  // 列表层级栈：每层记录列表标记缩进、内容缩进与所属列表节点
  let listStack = [];
  let pendingBlank = false;

  const appendBlock = (block) => {
    const container = listStack.at(-1)?.list.items.at(-1).blocks ?? blocks;
    container.push(block);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const spaced = pendingBlank && blocks.length > 0;

    if (!line.trim()) {
      pendingBlank = true;
      continue;
    }
    pendingBlank = false;

    const indent = leadingSpaces(line);
    const fence = FENCE_OPEN_PATTERN.exec(line);
    if (fence) {
      const codeLines = [];
      let closeIndex = index + 1;
      for (; closeIndex < lines.length; closeIndex += 1) {
        const close = FENCE_CLOSE_PATTERN.exec(lines[closeIndex]);
        if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length) break;
        codeLines.push(lines[closeIndex]);
      }
      listStack = [];
      blocks.push({ type: 'code', text: codeLines.join('\n'), spaced });
      index = closeIndex;
      continue;
    }

    // 列表外缩进 4 列及以上的行是缩进代码，即使看起来像列表项
    const isTopLevelCode = listStack.length === 0 && indent >= INDENTED_CODE_COLUMNS;
    const listItem = RULE_PATTERN.test(line) || isTopLevelCode ? null : LIST_ITEM_PATTERN.exec(line);
    if (listItem) {
      const markerIndent = listItem[1].length;
      const ordered = listItem[3] !== undefined;
      const contentIndent = markerIndent + listItem[2].length + 1;
      const item = { inlines: parseInlineMarkdown(listItem[4] ?? ''), blocks: [], spaced };
      while (listStack.length > 0 && markerIndent < listStack.at(-1).markerIndent) listStack.pop();
      const level = listStack.at(-1);
      if (level && markerIndent < level.contentIndent && level.list.ordered === ordered) {
        level.list.items.push(item);
        continue;
      }
      if (level && markerIndent < level.contentIndent) listStack.pop();
      // 新列表的段落间隔记在列表上，首项不再重复
      item.spaced = false;
      const list = { type: 'list', ordered, start: ordered ? Number(listItem[3]) : 1, items: [item], spaced };
      appendBlock(list);
      listStack.push({ markerIndent, contentIndent, list });
      continue;
    }

    // 缩进到列表项内容列的行是该项的后续内容；其余行结束列表
    while (listStack.length > 0 && indent < listStack.at(-1).contentIndent) listStack.pop();
    if (listStack.length > 0) {
      appendBlock(parseLineBlock(line.trim(), spaced));
      continue;
    }

    if (indent >= INDENTED_CODE_COLUMNS) {
      // 两段缩进代码之间的空行属于同一个代码块
      const codeLines = [line.slice(INDENTED_CODE_COLUMNS)];
      let lastCodeIndex = index;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (!lines[next].trim()) continue;
        if (leadingSpaces(lines[next]) < INDENTED_CODE_COLUMNS) break;
        for (let blank = lastCodeIndex + 1; blank < next; blank += 1) codeLines.push('');
        codeLines.push(lines[next].slice(INDENTED_CODE_COLUMNS));
        lastCodeIndex = next;
      }
      blocks.push({ type: 'code', text: codeLines.join('\n'), spaced });
      index = lastCodeIndex;
      continue;
    }

    blocks.push(parseLineBlock(line, spaced));
  }

  return blocks;
};

const renderInlines = (doc, parent, inlines) => {
  for (const node of inlines) {
    if (node.type === 'text') {
      parent.append(node.text);
      continue;
    }
    if (node.type === 'code') {
      const codeEl = doc.createElement('code');
      codeEl.textContent = node.text;
      parent.append(codeEl);
      continue;
    }
    const tagName = { strong: 'strong', em: 'em', del: 'del', link: 'a' }[node.type];
    const el = doc.createElement(tagName);
    if (node.type === 'link') {
      el.href = node.href;
      el.title = node.href;
      // 宿主把新窗口请求交给系统浏览器打开，不在侧栏 iframe 内导航
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    }
    renderInlines(doc, el, node.children);
    parent.append(el);
  }
};

const renderBlock = (doc, block) => {
  let el;
  if (block.type === 'paragraph' || block.type === 'quote') {
    el = doc.createElement(block.type === 'quote' ? 'blockquote' : 'p');
    renderInlines(doc, el, block.inlines);
  } else if (block.type === 'heading') {
    el = doc.createElement(`h${block.level}`);
    renderInlines(doc, el, block.inlines);
  } else if (block.type === 'rule') {
    el = doc.createElement('hr');
  } else if (block.type === 'code') {
    el = doc.createElement('pre');
    const codeEl = doc.createElement('code');
    codeEl.textContent = block.text;
    el.append(codeEl);
  } else {
    el = doc.createElement(block.ordered ? 'ol' : 'ul');
    if (block.ordered && block.start !== 1) el.start = block.start;
    for (const item of block.items) {
      const itemEl = doc.createElement('li');
      itemEl.classList.toggle('is-spaced', item.spaced);
      renderInlines(doc, itemEl, item.inlines);
      for (const child of item.blocks) itemEl.append(renderBlock(doc, child));
      el.append(itemEl);
    }
  }
  el.classList.toggle('is-spaced', block.spaced);
  return el;
};

/**
 * 把提交说明渲染为 Markdown DOM。
 *
 * @param {Document} doc 用于创建节点的文档
 * @param {string} message 完整提交说明（标题行 + 正文）
 * @returns {HTMLElement} `.gw-markdown` 容器（只创建节点，不挂载）
 */
export const renderCommitMarkdown = (doc, message) => {
  const containerEl = doc.createElement('div');
  containerEl.className = 'gw-markdown';
  for (const block of parseCommitMarkdown(message)) {
    containerEl.append(renderBlock(doc, block));
  }
  return containerEl;
};
