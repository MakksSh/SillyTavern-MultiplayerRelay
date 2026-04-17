(function () {
  const SHADOW_FONT_AWESOME_URL = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css';
  const SHADOW_RICH_FALLBACK_CSS = `
    .relay-rich-html {
      color: inherit;
      line-height: 1.52;
    }

    .relay-rich-html .flex-container,
    .relay-rich-html [class*="inline-flex"] {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.6rem;
    }

    .relay-rich-html button,
    .relay-rich-html .menu_button {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.58rem 0.9rem;
      color: #f8fafc;
      background: rgba(15, 23, 42, 0.82);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 0.8rem;
      box-shadow: inset 0 0 0 1px rgba(249, 115, 22, 0.06);
      cursor: default;
      font: inherit;
    }

    .relay-rich-html .fa-solid,
    .relay-rich-html .fa-regular,
    .relay-rich-html .fa-brands {
      width: 1rem;
      text-align: center;
      color: #f97316;
    }

    .relay-rich-html a {
      color: #fdba74;
    }

    .relay-rich-html img {
      max-width: 100%;
      height: auto;
      border-radius: 0.9rem;
    }

    .relay-rich-html table {
      width: 100%;
      border-collapse: collapse;
    }

    .relay-rich-html th,
    .relay-rich-html td {
      padding: 0.45rem 0.6rem;
      border: 1px solid rgba(148, 163, 184, 0.14);
    }

    .relay-rich-html code {
      padding: 0.12rem 0.35rem;
      border-radius: 0.45rem;
      background: rgba(15, 23, 42, 0.9);
      color: #fde68a;
    }
  `;

  function getWsUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  function createSocket() {
    return new WebSocket(getWsUrl());
  }

  function sendEvent(socket, type, payload = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(JSON.stringify({ type, payload }));
    return true;
  }

  function debounce(callback, wait = 300) {
    let timerId = null;
    return (...args) => {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(() => callback(...args), wait);
    };
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function looksLikeHtml(value) {
    return /<\/?[a-z][\s\S]*>/i.test(String(value || ''));
  }

  function sanitizeRichHtml(value, allowStyles = false) {
    const html = String(value || '');
    if (!html || !looksLikeHtml(html)) {
      return null;
    }

    if (!window.DOMPurify) {
      return null;
    }

    const sanitized = window.DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: allowStyles
        ? ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'option', 'link', 'meta']
        : ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'option', 'link', 'meta'],
    }).trim();

    return sanitized || null;
  }

  function extractStyleBlocks(html) {
    const styles = [];
    const htmlWithoutStyles = String(html || '').replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, cssText) => {
      styles.push(String(cssText || ''));
      return '';
    });

    return {
      htmlWithoutStyles,
      styles,
    };
  }

  function sanitizeInlineCss(cssText) {
    return String(cssText || '')
      .replace(/@import[\s\S]*?;/gi, '')
      .replace(/expression\s*\([^)]*\)/gi, '')
      .replace(/javascript\s*:/gi, '')
      .trim();
  }

  function renderRichLogContent(container, entry, renderOptions = {}) {
    const allowHtml = Boolean(renderOptions.allowHtml);
    const allowStyles = allowHtml && Boolean(renderOptions.allowStyles);
    const isRichEntry = entry.type === 'ai_reply' || entry.type === 'system';
    const sanitizedHtml = allowHtml && isRichEntry ? sanitizeRichHtml(entry.text, allowStyles) : null;

    container.className = 'entry-text';
    container.innerHTML = '';

    if (!sanitizedHtml) {
      if (container.shadowRoot) {
        container.shadowRoot.innerHTML = '<slot></slot>';
      }
      container.textContent = String(entry.text || '');
      return;
    }

    if (!allowStyles) {
      if (container.shadowRoot) {
        container.shadowRoot.innerHTML = '<slot></slot>';
      }
      container.classList.add('rendered-html');
      container.innerHTML = sanitizedHtml;
      return;
    }

    const { htmlWithoutStyles, styles } = extractStyleBlocks(sanitizedHtml);
    const shadowRoot = container.shadowRoot || container.attachShadow({ mode: 'open' });
    const styleTags = styles
      .map(sanitizeInlineCss)
      .filter(Boolean)
      .map((cssText) => `<style>${cssText}</style>`)
      .join('');

    shadowRoot.innerHTML = `
      <link rel="stylesheet" href="${SHADOW_FONT_AWESOME_URL}">
      <style>
        :host {
          display: block;
          color: inherit;
          font: inherit;
          line-height: 1.52;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        :host * {
          box-sizing: border-box;
          max-width: 100%;
        }

        :host a {
          color: #fdba74;
        }

        :host img {
          max-width: 100%;
          height: auto;
        }
      </style>
      <style>${SHADOW_RICH_FALLBACK_CSS}</style>
      ${styleTags}
      <div class="relay-rich-html">${htmlWithoutStyles}</div>
    `;
    container.classList.add('rendered-html', 'uses-shadow-html');
  }

  function formatTimestamp(value) {
    if (!value) {
      return '';
    }

    return new Date(value).toLocaleString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
    });
  }

  function setStatusPill(element, text, tone = '') {
    if (!element) {
      return;
    }

    element.textContent = text;
    element.classList.remove('is-ok', 'is-warn', 'is-danger');

    if (tone) {
      element.classList.add(`is-${tone}`);
    }
  }

  function ensureToastStack() {
    let stack = document.getElementById('relayToastStack');
    if (stack) {
      return stack;
    }

    stack = document.createElement('div');
    stack.id = 'relayToastStack';
    stack.className = 'relay-toast-stack';
    document.body.appendChild(stack);
    return stack;
  }

  function showAlert(element, message) {
    if (element) {
      element.classList.add('d-none');
      element.textContent = '';
    }

    if (!message) {
      return;
    }

    const stack = ensureToastStack();
    while (stack.children.length >= 4) {
      stack.firstElementChild?.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'relay-toast relay-toast-error';
    toast.setAttribute('role', 'status');
    toast.textContent = String(message);
    stack.appendChild(toast);

    window.requestAnimationFrame(() => {
      toast.classList.add('is-visible');
    });

    const removeToast = () => {
      toast.classList.remove('is-visible');
      toast.classList.add('is-hiding');
      window.setTimeout(() => toast.remove(), 220);
    };

    window.setTimeout(removeToast, 5000);
  }

  async function copyFieldValue(fieldId, button) {
    const field = document.getElementById(fieldId);
    if (!field || !field.value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(field.value);
      const originalText = button.textContent;
      button.textContent = 'Copied';
      window.setTimeout(() => {
        button.textContent = originalText;
      }, 1000);
    } catch (error) {
      console.error('Copy failed', error);
    }
  }

  function wireCopyButtons() {
    document.querySelectorAll('[data-copy-target]').forEach((button) => {
      button.addEventListener('click', () => copyFieldValue(button.dataset.copyTarget, button));
    });
  }

  function readQuery(name) {
    return new URLSearchParams(window.location.search).get(name) || '';
  }

  function describeRoomStatus(status) {
    switch (status) {
      case 'ready':
        return { label: 'Ready', tone: 'ok' };
      case 'generating':
        return { label: 'Generating', tone: 'warn' };
      default:
        return { label: 'Waiting host', tone: 'danger' };
    }
  }

  function renderPlayers(container, players, currentPlayerId, showDrafts) {
    if (!container) {
      return;
    }

    if (!players || !players.length) {
      container.innerHTML = '<div class="empty-state">Игроков пока нет.</div>';
      return;
    }

    container.innerHTML = players.map((player) => {
      const draftHtml = showDrafts && player.draft
        ? `<div class="entry-text mt-2">${escapeHtml(player.draft)}</div>`
        : '';

      return `
        <article class="player-card ${player.id === currentPlayerId ? 'is-self' : ''}">
          <div class="d-flex justify-content-between gap-2 align-items-start">
            <div>
              <div class="fw-semibold">${escapeHtml(player.name)}${player.id === currentPlayerId ? ' <span class="text-secondary">(you)</span>' : ''}</div>
              <div class="entry-meta">${escapeHtml(player.role)}</div>
            </div>
            <div class="player-meta">
              <span class="mini-pill ok">online</span>
              <span class="mini-pill ${player.ready ? 'ok' : 'warn'}">${player.ready ? 'ready' : 'not ready'}</span>
              <span class="mini-pill ${player.hasDraft ? 'ok' : ''}">${player.hasDraft ? 'draft' : 'no draft'}</span>
            </div>
          </div>
          ${draftHtml}
        </article>
      `;
    }).join('');
  }

  function renderLog(container, entries, emptyText, renderOptions = {}) {
    if (!container) {
      return;
    }

    if (!entries || !entries.length) {
      container.innerHTML = `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
      return;
    }

    const placeholders = [];
    container.innerHTML = entries.map((entry, index) => {
      const bodyId = `relay-log-body-${index}`;
      placeholders.push({ bodyId, entry });

      return `
        <article class="log-entry ${escapeHtml(entry.type || '')}">
          <div class="d-flex justify-content-between gap-3">
            <div class="fw-semibold">${escapeHtml(entry.author || entry.type || 'entry')}</div>
            <div class="entry-meta">${formatTimestamp(entry.createdAt)}</div>
          </div>
          <div id="${bodyId}" class="entry-text"></div>
        </article>
      `;
    }).join('');

    placeholders.forEach(({ bodyId, entry }) => {
      const target = document.getElementById(bodyId);
      if (!target) {
        return;
      }

      renderRichLogContent(target, entry, renderOptions);
    });
    container.scrollTop = container.scrollHeight;
  }

  function renderChat(container, entries, emptyText) {
    if (!container) {
      return;
    }

    if (!entries || !entries.length) {
      container.innerHTML = `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
      return;
    }

    container.innerHTML = entries.map((entry) => `
      <article class="chat-entry">
        <div class="d-flex justify-content-between gap-3">
          <div class="fw-semibold">${escapeHtml(entry.author)}</div>
          <div class="entry-meta">${formatTimestamp(entry.createdAt)}</div>
        </div>
        <div class="entry-text">${escapeHtml(entry.text)}</div>
      </article>
    `).join('');
    container.scrollTop = container.scrollHeight;
  }

  window.RelayCommon = {
    createSocket,
    debounce,
    describeRoomStatus,
    readQuery,
    renderChat,
    renderLog,
    renderPlayers,
    sendEvent,
    setStatusPill,
    showAlert,
    wireCopyButtons,
  };
})();
