// ============================================================
// cells.js — Cell list rendering, run flow, drag-drop reorder
// (attaches to window.Anb.cells)
// ============================================================

window.Anb = window.Anb || {};

(function () {
  const Anb = window.Anb;
  const editor = Anb.editor;
  const llm = Anb.llm;

  let notebookEl = null;
  let saveNotebookDebounced = null;
  let cells = [];

  // --- public API ----------------------------------------------------------

  function init(notebookElement, debouncedSave) {
    notebookEl = notebookElement;
    saveNotebookDebounced = debouncedSave;
  }

  function getCells() {
    return cells;
  }

  function render(cellsData) {
    cells = (cellsData || []).map((c) => ({
      id: c.id || newId(),
      content: c.content || '',
      output: c.output || '',
      status: 'idle',
      previewMode: !!c.previewMode,
      cm: null,
      cellEl: null,
      outputEl: null,
      runBtn: null,
      labelEl: null,
      toggleBtn: null,
      inputHost: null,
      previewEl: null
    }));

    if (cells.length === 0) {
      cells.push(createBlankCell());
    }

    notebookEl.innerHTML = '';
    for (const cell of cells) {
      renderCell(cell);
    }
    refreshAllLabels();
  }

  function addCell(position = 'below', atIndex = -1) {
    const newCell = createBlankCell();
    let insertAt;
    if (position === 'above') {
      insertAt = atIndex >= 0 ? atIndex : 0;
    } else {
      insertAt = atIndex >= 0 ? atIndex + 1 : cells.length;
    }
    cells.splice(insertAt, 0, newCell);

    rerenderAll();
    saveNotebookDebounced();

    setTimeout(() => editor.focus(newCell.cm), 50);
    return newCell;
  }

  function deleteCell(id) {
    if (cells.length <= 1) {
      alert('Cannot delete the last cell.');
      return;
    }
    const idx = cells.findIndex((c) => c.id === id);
    if (idx < 0) return;
    if (!confirm('Delete this cell?')) return;

    cells.splice(idx, 1);
    rerenderAll();
    saveNotebookDebounced();
  }

  function clearAllOutputs() {
    if (!confirm('Clear all cell outputs?')) return;
    for (const cell of cells) {
      clearCellOutput(cell.id);
    }
    saveNotebookDebounced();
  }

  function clearCellOutput(id) {
    const cell = cells.find((c) => c.id === id);
    if (!cell) return;
    cell.output = '';
    cell.status = 'idle';
    cell.outputEl.innerHTML = '';
    cell.cellEl.classList.remove('cell-running', 'cell-error');
    if (cell.runBtn) cell.runBtn.disabled = false;
    saveNotebookDebounced();
  }

  async function runCell(id, settings) {
    const idx = cells.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const cell = cells[idx];

    if (!cell.content.trim()) {
      cell.outputEl.innerHTML = '<div class="output-empty">⚠ Empty cell — nothing to run.</div>';
      return;
    }

    const sysPrompt = `You are an AI assistant in an AgenticNotebook.
The user provides content from prior notebook cells as background context, then the current cell.
Respond only to the current cell, using prior cells as background.`;

    const userParts = cells.slice(0, idx + 1).map((c, k) => {
      const tag = k === idx ? ' (current)' : '';
      const body = c.content.trim() || '(empty)';
      return `[Cell ${k + 1}${tag}]\n${body}`;
    });
    const userContent =
      userParts.join('\n\n---\n\n') +
      `\n\nPlease respond to Cell ${idx + 1}.`;

    const messages = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userContent }
    ];

    cell.output = '';
    cell.status = 'running';
    cell.outputEl.innerHTML = '<div class="output-streaming">Running…</div>';
    cell.runBtn.disabled = true;
    cell.cellEl.classList.add('cell-running');
    cell.cellEl.classList.remove('cell-error');

    let accumulated = '';
    let renderTimer = null;

    function flushRender() {
      renderTimer = null;
      const liveCell = cells.find((c) => c.id === id);
      if (!liveCell) return;
      liveCell.outputEl.innerHTML = renderMarkdown(accumulated);
    }

    function scheduleRender() {
      if (renderTimer) return;
      renderTimer = setTimeout(flushRender, 200);
    }

    await llm.streamChatCompletion({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      messages,
      onChunk: (_delta, full) => {
        accumulated = full;
        scheduleRender();
      },
      onDone: (full) => {
        if (renderTimer) {
          clearTimeout(renderTimer);
          renderTimer = null;
        }
        accumulated = full;
        cell.output = accumulated;
        cell.outputEl.innerHTML = renderMarkdown(accumulated);
        cell.status = 'idle';
        cell.runBtn.disabled = false;
        cell.cellEl.classList.remove('cell-running');
        saveNotebookDebounced();
      },
      onError: (err) => {
        if (renderTimer) {
          clearTimeout(renderTimer);
          renderTimer = null;
        }
        const before = accumulated ? renderMarkdown(accumulated) : '';
        const errHtml = `<div class="output-error">❌ ${escapeHtml(err.message)}</div>`;
        cell.outputEl.innerHTML = before + errHtml;
        cell.output = accumulated;
        cell.status = 'error';
        cell.runBtn.disabled = false;
        cell.cellEl.classList.remove('cell-running');
        cell.cellEl.classList.add('cell-error');
        saveNotebookDebounced();
      }
    });
  }

  async function runAll(settings) {
    for (const cell of cells) {
      await runCell(cell.id, settings);
    }
  }

  function exportNotebook() {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      cells: cells.map((c) => ({
        id: c.id,
        content: c.content,
        output: c.output
      }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(Anb.notebooks.getName())}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportNotebookHtml() {
    const cellsHtml = cells.map((c, i) => {
      const inputHtml = c.content ? renderMarkdown(c.content) : '';
      const outputHtml = c.output ? renderMarkdown(c.output) : '';
      return `    <section class="cell">
      <header class="cell-label">[${i + 1}]</header>
${inputHtml ? `      <div class="cell-input">${inputHtml}</div>\n` : ''}${outputHtml ? `      <div class="cell-output">${outputHtml}</div>\n` : ''}    </section>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>AgenticNotebook Export</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 900px; margin: 0 auto; padding: 24px; background: #fafafa; color: #1a1a1a; }
  h1.title { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #888; font-size: 12px; margin-bottom: 24px; }
  .cell { background: #fff; border: 1px solid #ddd; border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
  .cell-label { font-family: 'JetBrains Mono', 'Menlo', monospace; font-size: 12px; color: #888; padding: 6px 12px; background: #f5f5f5; border-bottom: 1px solid #eee; }
  .cell-input { padding: 12px 16px; background: #fff; border-bottom: 1px solid #eee; }
  .cell-output { padding: 12px 16px; background: #fafafa; }
  /* Markdown typography */
  h1, h2, h3, h4, h5, h6 { margin: 14px 0 8px; font-weight: 600; line-height: 1.3; }
  h1 { font-size: 22px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  h2 { font-size: 19px; }
  h3 { font-size: 16px; }
  h4 { font-size: 15px; }
  p { margin: 8px 0; }
  ul, ol { padding-left: 24px; margin: 8px 0; }
  li { margin: 2px 0; }
  code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-family: 'JetBrains Mono', 'Menlo', monospace; font-size: 0.9em; }
  pre { background: #1e1e1e; color: #e6e6e6; padding: 12px 14px; border-radius: 4px; overflow-x: auto; margin: 8px 0; font-size: 13px; }
  pre code { background: transparent; padding: 0; color: inherit; }
  blockquote { border-left: 3px solid #1f6feb; margin: 8px 0; padding: 4px 12px; color: #555; }
  a { color: #1f6feb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  table { border-collapse: collapse; margin: 8px 0; }
  th, td { border: 1px solid #ddd; padding: 6px 12px; }
  th { background: #f5f5f5; font-weight: 600; }
  hr { border: none; border-top: 1px solid #eee; margin: 12px 0; }
  .katex-display { margin: 12px 0; overflow-x: auto; }
  .katex { font-size: 1.05em; white-space: nowrap; }
</style>
</head>
<body>
  <h1 class="title">📓 AgenticNotebook Export</h1>
  <div class="meta">Exported ${new Date().toLocaleString()} · ${cells.length} cells</div>
${cellsHtml}
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(Anb.notebooks.getName())}-${Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportNotebookAgent() {
    // Bake current settings in as the agent's defaults (fallback to Agnes)
    let settings = { baseUrl: 'https://api.agnes-ai.cn/v1/chat/completions', apiKey: '', model: 'agnes-3.0-flash' };
    try {
      const s = await Anb.settings.load();
      settings = { baseUrl: s.baseUrl || settings.baseUrl, apiKey: '', model: s.model || settings.model };
    } catch (err) {
      console.warn('agent export: failed to read settings, using defaults', err);
    }

    const name = Anb.notebooks.getName();

    // System prompt: whole notebook as the agent's background knowledge
    const sysParts = cells.map((c, i) => {
      const body = [];
      if (c.content.trim()) body.push(c.content.trim());
      if (c.output.trim()) body.push('(output) ' + c.output.trim());
      return `[Cell ${i + 1}]\n${body.join('\n') || '(empty)'}`;
    });
    const sysPrompt =
      `You are an AI assistant inside an AgenticNotebook export called "${name}".\n` +
      `The notebook content below is your background knowledge.\n` +
      `Answer the user's questions using this material when relevant, and be concise.\n\n` +
      sysParts.join('\n\n---\n\n');

    const jsonSafe = (v) =>
      JSON.stringify(v)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(name)} · Agent App</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f7f7f8; color: #1a1a1a; display: flex; flex-direction: column; }
  /* ---- top bar ---- */
  .topbar { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: #fff; border-bottom: 1px solid #e4e4e7; }
  .brand { font-weight: 600; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 11px; color: #fff; background: #1f6feb; border-radius: 999px; padding: 2px 8px; flex-shrink: 0; }
  .spacer { flex: 1; }
  .icon-btn { width: 32px; height: 32px; border: 1px solid #e4e4e7; background: #fff; border-radius: 6px; cursor: pointer; font-size: 16px; line-height: 1; }
  .icon-btn:hover { background: #f0f0f0; }
  /* ---- chat ---- */
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; margin: 12px 16px 16px; background: #fff; border: 1px solid #e4e4e7; border-radius: 8px; overflow: hidden; }
  .messages { flex: 1; overflow-y: auto; padding: 16px; }
  .msg { margin-bottom: 12px; max-width: 88%; line-height: 1.6; font-size: 14px; }
  .msg.user { margin-left: auto; background: #1f6feb; color: #fff; border-radius: 12px 12px 2px 12px; padding: 8px 12px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.assistant { background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 12px 12px 12px 2px; padding: 10px 14px; }
  .msg.assistant .hint { color: #888; font-style: italic; }
  .err { color: #d33; margin-top: 8px; }
  /* markdown typography inside assistant bubbles */
  .msg.assistant > *:first-child { margin-top: 0; }
  .msg.assistant > *:last-child { margin-bottom: 0; }
  .msg.assistant h1, .msg.assistant h2, .msg.assistant h3, .msg.assistant h4 { margin: 12px 0 6px; font-weight: 600; line-height: 1.3; }
  .msg.assistant h1 { font-size: 20px; border-bottom: 1px solid #eee; padding-bottom: 3px; }
  .msg.assistant h2 { font-size: 17px; } .msg.assistant h3 { font-size: 15px; } .msg.assistant h4 { font-size: 14px; }
  .msg.assistant p { margin: 8px 0; }
  .msg.assistant ul, .msg.assistant ol { padding-left: 22px; margin: 8px 0; }
  .msg.assistant li { margin: 2px 0; }
  .msg.assistant code { background: #e8e8ea; padding: 2px 6px; border-radius: 3px; font-family: 'JetBrains Mono', 'Menlo', monospace; font-size: 0.9em; }
  .msg.assistant pre { background: #1e1e1e; color: #e6e6e6; padding: 12px 14px; border-radius: 4px; overflow-x: auto; margin: 8px 0; font-size: 13px; }
  .msg.assistant pre code { background: transparent; padding: 0; color: inherit; }
  .msg.assistant blockquote { border-left: 3px solid #1f6feb; margin: 8px 0; padding: 4px 12px; color: #555; }
  .msg.assistant a { color: #1f6feb; text-decoration: none; } .msg.assistant a:hover { text-decoration: underline; }
  .msg.assistant table { border-collapse: collapse; margin: 8px 0; }
  .msg.assistant th, .msg.assistant td { border: 1px solid #ddd; padding: 5px 10px; }
  .msg.assistant th { background: #eef0f2; font-weight: 600; }
  .msg.assistant hr { border: none; border-top: 1px solid #eee; margin: 10px 0; }
  .msg.assistant .katex-display { margin: 10px 0; overflow-x: auto; }
  .msg.assistant .katex { font-size: 1.05em; white-space: nowrap; }
  /* ---- composer ---- */
  .composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e4e4e7; }
  .composer input { flex: 1; padding: 10px 12px; border: 1px solid #e4e4e7; border-radius: 6px; font-size: 14px; }
  .composer input:focus { outline: none; border-color: #1f6feb; }
  .composer button { padding: 10px 16px; border: none; border-radius: 6px; background: #1f6feb; color: #fff; font-size: 14px; cursor: pointer; }
  .composer button:disabled { opacity: 0.5; cursor: not-allowed; }
  .composer #btn-clear-chat { background: #fff; color: #666; border: 1px solid #e4e4e7; }
  /* ---- settings modal ---- */
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal.hidden { display: none; }
  .modal-content { background: #fff; border-radius: 8px; padding: 20px; width: min(460px, 90vw); box-shadow: 0 10px 30px rgba(0,0,0,.2); }
  .modal-content h2 { margin: 0 0 14px; font-size: 17px; }
  .modal-content label { display: block; margin-bottom: 12px; font-size: 13px; color: #555; }
  .modal-content label span { display: block; margin-bottom: 4px; }
  .modal-content input { width: 100%; padding: 8px 10px; border: 1px solid #e4e4e7; border-radius: 6px; font-size: 14px; }
  .modal-content input:focus { outline: none; border-color: #1f6feb; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .modal-actions button { padding: 8px 16px; border-radius: 6px; border: 1px solid #e4e4e7; background: #fff; cursor: pointer; font-size: 13px; }
  .modal-actions button[type=submit] { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  .modal-hint { font-size: 12px; color: #888; margin-top: 12px; word-wrap: break-word; }
</style>
</head>
<body>
  <header class="topbar">
    <span class="brand">📓 ${escapeHtml(name)}</span>
    <span class="badge">Agent App</span>
    <div class="spacer"></div>
    <button class="icon-btn" id="btn-settings" title="LLM Settings" aria-label="LLM Settings">⚙️</button>
  </header>

  <main class="chat">
    <div id="messages" class="messages"></div>
    <form id="chat-form" class="composer" autocomplete="off">
      <button type="button" id="btn-clear-chat" title="Clear chat" aria-label="Clear chat">🗑</button>
      <input id="chat-input" placeholder="Ask about the notebook… (Enter to send)">
      <button type="submit">Send</button>
    </form>
  </main>

  <div id="settings-modal" class="modal hidden" role="dialog" aria-labelledby="settings-title">
    <div class="modal-content">
      <h2 id="settings-title">⚙️ Agent LLM Settings</h2>
      <form id="settings-form">
        <label><span>Base URL</span><input type="text" id="cfg-base-url" required></label>
        <label><span>API Key</span><input type="password" id="cfg-api-key" required></label>
        <label><span>Model</span><input type="text" id="cfg-model" required></label>
        <div class="modal-actions">
          <button type="button" id="cfg-cancel">Cancel</button>
          <button type="submit">Save</button>
        </div>
      </form>
      <p class="modal-hint" id="cfg-hint"></p>
    </div>
  </div>

<script src="https://cdn.jsdelivr.net/npm/marked@11.1.0/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/highlight.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
<script>
"use strict";
/* ===== baked at export time ===== */
var NOTEBOOK_NAME = ${jsonSafe(name)};
var AGENT_DEFAULTS = ${jsonSafe({ baseUrl: settings.baseUrl, model: settings.model })};
var SYSTEM_PROMPT = ${jsonSafe(sysPrompt)};

var LS_KEY = "agentic-notebook-agent-settings";

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function loadSettings() {
  var base = { baseUrl: AGENT_DEFAULTS.baseUrl, apiKey: "", model: AGENT_DEFAULTS.model };
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) {
      var s = JSON.parse(raw);
      for (var k in base) { if (s && s[k] !== undefined && s[k] !== null && s[k] !== "") base[k] = s[k]; }
    }
  } catch (e) {}
  return base;
}
function saveSettings(s) { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {} }
function buildUrl(baseUrl) {
  var t = String(baseUrl || "").replace(/\\/+$/, "");
  if (/\\/chat\\/completions(\\?|$)/.test(t)) return t;
  if (/\\/v1$/.test(t)) return t + "/chat/completions";
  return t + "/v1/chat/completions";
}
function renderMarkdown(text) {
  if (!text) return "";
  try {
    marked.setOptions({ breaks: true, gfm: true, highlight: function (code, lang) {
      if (lang && window.hljs && hljs.getLanguage(lang)) { try { return hljs.highlight(code, { language: lang }).value; } catch (e) {} }
      return escapeHtml(code);
    }});
    var html = marked.parse(text);
    if (window.renderMathInElement) {
      var wrap = document.createElement("div");
      wrap.innerHTML = html;
      try {
        window.renderMathInElement(wrap, { delimiters: [ {left:"$$",right:"$$",display:true}, {left:"$",right:"$",display:false} ], throwOnError: false, ignoredClasses: ["katex"] });
        html = wrap.innerHTML;
      } catch (e) {}
    }
    return html;
  } catch (e) {
    return "<pre>" + escapeHtml(text) + "</pre>";
  }
}
function streamChat(opts) {
  var settings = opts.settings;
  if (!settings.apiKey) { opts.onError(new Error("Missing API Key — open ⚙ Settings to set it.")); return; }
  if (!settings.baseUrl) { opts.onError(new Error("Missing Base URL — open ⚙ Settings to set it.")); return; }
  if (!settings.model) { opts.onError(new Error("Missing Model — open ⚙ Settings to set it.")); return; }
  var url = buildUrl(settings.baseUrl);
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + settings.apiKey },
    body: JSON.stringify({ model: settings.model, messages: opts.messages, stream: true, stream_options: { include_usage: true } })
  }).then(function (resp) {
    if (!resp.ok) {
      return resp.text().then(function (txt) { throw new Error("HTTP " + resp.status + " " + (txt || resp.statusText).slice(0, 200)); });
    }
    var reader = resp.body.getReader();
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    var acc = "";
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) { opts.onDone(acc); return; }
        buffer += decoder.decode(r.value, { stream: true });
        var lines = buffer.split("\\n");
        buffer = lines.pop() || "";
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || line.indexOf("data:") !== 0) continue;
          var payload = line.slice(5).trim();
          if (payload === "[DONE]") { opts.onDone(acc); return; }
          var obj;
          try { obj = JSON.parse(payload); } catch (e) { continue; }
          if (obj.error) { opts.onError(new Error(obj.error.message || "API error")); return; }
          var delta = obj.choices && obj.choices[0] && obj.choices[0].delta ? obj.choices[0].delta.content : null;
          if (delta) { acc += delta; opts.onChunk(delta, acc); }
        }
        return pump();
      });
    }
    return pump();
  }).catch(function (err) {
    opts.onError(err instanceof Error ? err : new Error(String(err)));
  });
}

/* ===== chat ===== */
var chatHistory = [ { role: "system", content: SYSTEM_PROMPT } ];
var messagesEl = document.getElementById("messages");
var form = document.getElementById("chat-form");
var input = document.getElementById("chat-input");
var sendBtn = form.querySelector("button[type=submit]");
var busy = false;

function addBubble(role, html) {
  var div = document.createElement("div");
  div.className = "msg " + role;
  div.innerHTML = html;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}
function addUser(text) { return addBubble("user", escapeHtml(text)); }
function clearChat() {
  chatHistory = [ { role: "system", content: SYSTEM_PROMPT } ];
  messagesEl.innerHTML = "";
  addBubble("assistant", '<div class="hint">Ask me anything about this notebook.</div>');
}
document.getElementById("btn-clear-chat").addEventListener("click", clearChat);

form.addEventListener("submit", function (e) {
  e.preventDefault();
  if (busy) return;
  var text = input.value.trim();
  if (!text) return;
  input.value = "";
  chatHistory.push({ role: "user", content: text });
  addUser(text);
  busy = true;
  sendBtn.disabled = true;

  var bubble = addBubble("assistant", "");
  var raw = "";
  var timer = null;
  function flush() { timer = null; bubble.innerHTML = renderMarkdown(raw); messagesEl.scrollTop = messagesEl.scrollHeight; }
  function schedule() { if (timer) return; timer = setTimeout(flush, 150); }

  streamChat({
    settings: loadSettings(),
    messages: chatHistory,
    onChunk: function (d, full) { raw = full; schedule(); },
    onDone: function (full) {
      if (timer) { clearTimeout(timer); timer = null; }
      raw = full;
      bubble.innerHTML = renderMarkdown(full);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      chatHistory.push({ role: "assistant", content: full });
      busy = false; sendBtn.disabled = false; input.focus();
    },
    onError: function (err) {
      if (timer) { clearTimeout(timer); timer = null; }
      bubble.innerHTML = bubble.innerHTML + '<div class="err">❌ ' + escapeHtml(err.message || String(err)) + '</div>';
      busy = false; sendBtn.disabled = false; input.focus();
    }
  });
});

/* ===== settings ===== */
var modal = document.getElementById("settings-modal");
var settingsForm = document.getElementById("settings-form");
var baseUrlInput = document.getElementById("cfg-base-url");
var apiKeyInput = document.getElementById("cfg-api-key");
var modelInput = document.getElementById("cfg-model");
var cfgHint = document.getElementById("cfg-hint");
function openSettings() {
  var s = loadSettings();
  baseUrlInput.value = s.baseUrl;
  apiKeyInput.value = s.apiKey;
  modelInput.value = s.model;
  cfgHint.textContent = "Defaults baked in: " + AGENT_DEFAULTS.baseUrl + " / " + AGENT_DEFAULTS.model + ". The API key is stored only in this browser.";
  modal.classList.remove("hidden");
  baseUrlInput.focus();
}
function closeSettings() { modal.classList.add("hidden"); }
document.getElementById("btn-settings").addEventListener("click", openSettings);
document.getElementById("cfg-cancel").addEventListener("click", closeSettings);
modal.addEventListener("click", function (e) { if (e.target === modal) closeSettings(); });
settingsForm.addEventListener("submit", function (e) {
  e.preventDefault();
  saveSettings({ baseUrl: baseUrlInput.value.trim(), apiKey: apiKeyInput.value.trim(), model: modelInput.value.trim() });
  closeSettings();
});

clearChat();
input.focus();
</script>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(name)}-agent-${Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function createBlankCell() {
    return {
      id: newId(),
      content: '',
      output: '',
      status: 'idle',
      previewMode: false,
      cm: null,
      cellEl: null,
      outputEl: null,
      runBtn: null,
      labelEl: null,
      toggleBtn: null,
      inputHost: null,
      previewEl: null
    };
  }

  function newId() {
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function renderCell(cell) {
    const cellEl = document.createElement('div');
    cellEl.className = 'cell';
    cellEl.dataset.cellId = cell.id;

    // Top bar
    const topBar = document.createElement('div');
    topBar.className = 'cell-topbar';

    // Drag handle (visual cue) — the whole topbar is the drag source.
    const handle = document.createElement('span');
    handle.className = 'cell-drag-handle';
    handle.textContent = '⋮⋮';
    handle.title = 'Drag to reorder';
    topBar.appendChild(handle);

    const label = document.createElement('span');
    label.className = 'cell-label';
    cell.labelEl = label;

    const toolbar = document.createElement('div');
    toolbar.className = 'cell-toolbar';

    const runBtn = document.createElement('button');
    runBtn.className = 'cell-btn cell-run';
    runBtn.textContent = '▶';
    runBtn.title = 'Run cell (Shift+Enter)';
    runBtn.addEventListener('click', () => onRunClick(cell.id));

    const clearOutputBtn = document.createElement('button');
    clearOutputBtn.className = 'cell-btn cell-clear-output';
    clearOutputBtn.textContent = '🧹';
    clearOutputBtn.title = 'Clear this cell’s output';
    clearOutputBtn.addEventListener('click', () => clearCellOutput(cell.id));

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'cell-btn cell-toggle-preview';
    toggleBtn.textContent = '👁';
    toggleBtn.title = 'Show preview (rendered markdown)';
    toggleBtn.addEventListener('click', () => toggleCellPreview(cell.id));

    const insertAboveBtn = document.createElement('button');
    insertAboveBtn.className = 'cell-btn cell-insert-above';
    insertAboveBtn.textContent = '⏫';
    insertAboveBtn.title = 'Insert cell above';
    insertAboveBtn.addEventListener('click', () => addCell('above', idxOf(cell.id)));

    const insertBelowBtn = document.createElement('button');
    insertBelowBtn.className = 'cell-btn cell-insert-below';
    insertBelowBtn.textContent = '⏬';
    insertBelowBtn.title = 'Insert cell below';
    insertBelowBtn.addEventListener('click', () => addCell('below', idxOf(cell.id)));

    const delBtn = document.createElement('button');
    delBtn.className = 'cell-btn cell-del';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete cell';
    delBtn.addEventListener('click', () => deleteCell(cell.id));

    toolbar.appendChild(runBtn);
    toolbar.appendChild(toggleBtn);
    toolbar.appendChild(insertAboveBtn);
    toolbar.appendChild(insertBelowBtn);
    toolbar.appendChild(clearOutputBtn);
    toolbar.appendChild(delBtn);

    function idxOf(id) {
      return cells.findIndex((c) => c.id === id);
    }
    topBar.appendChild(label);
    topBar.appendChild(toolbar);
    cellEl.appendChild(topBar);

    // Input host (CodeMirror lives inside)
    const inputHost = document.createElement('div');
    inputHost.className = 'cell-input';
    cellEl.appendChild(inputHost);

    // Preview (rendered markdown of the input) — toggled by 👁/✏ button.
    // Double-clicking it returns to edit mode (Jupyter-style).
    const previewEl = document.createElement('div');
    previewEl.className = 'cell-preview';
    previewEl.style.display = 'none';
    previewEl.title = 'Double-click to edit';
    previewEl.addEventListener('dblclick', () => {
      const live = cells.find((cc) => cc.id === cell.id);
      if (live && live.previewMode) {
        live.previewMode = false;
        applyCellMode(live);
        setTimeout(() => editor.focus(live.cm), 50);
      }
    });
    cellEl.appendChild(previewEl);

    // Output area
    const outputEl = document.createElement('div');
    outputEl.className = 'cell-output';
    if (cell.output) {
      outputEl.innerHTML = renderMarkdown(cell.output);
    }
    cellEl.appendChild(outputEl);

    cell.cellEl = cellEl;
    cell.outputEl = outputEl;
    cell.runBtn = runBtn;
    cell.toggleBtn = toggleBtn;
    cell.inputHost = inputHost;
    cell.previewEl = previewEl;

    notebookEl.appendChild(cellEl);

    // The whole topbar is the drag handle, but we abort the drag when it
    // starts from interactive areas (toolbar buttons or the CodeMirror
    // editor) so the user can still click ▶/👁/🗑 and select text freely.
    topBar.draggable = true;
    topBar.addEventListener('dragstart', (e) => {
      if (
        e.target.closest('.cell-toolbar') ||
        e.target.closest('.CodeMirror')
      ) {
        e.preventDefault();
        return;
      }
      onDragStart(e, cell.id);
    });

    // Drop-target listeners on the whole cell
    cellEl.addEventListener('dragover', (e) => onDragOver(e, cell.id));
    cellEl.addEventListener('dragleave', (e) => onDragLeave(e, cell.id));
    cellEl.addEventListener('drop', (e) => onDrop(e, cell.id));
    cellEl.addEventListener('dragend', onDragEnd);

    // CodeMirror
    cell.cm = editor.createEditor(inputHost, cell.content);
    editor.onChange(cell.cm, (value) => {
      cell.content = value;
      refreshLabel(cell);
      if (cell.previewMode && cell.previewEl) {
        cell.previewEl.innerHTML = renderMarkdown(value);
      }
      saveNotebookDebounced();
    });
    editor.getWrapper(cell.cm).addEventListener('cell:shift-enter', () => {
      handleShiftEnter(cell.id);
    });

    // Apply initial mode (edit by default)
    applyCellMode(cell);
  }

  function rerenderAll() {
    const dataSnapshot = cells.map((c) => ({
      id: c.id,
      content: c.content,
      output: c.output,
      previewMode: c.previewMode
    }));
    notebookEl.innerHTML = '';
    render(dataSnapshot);
  }

  function refreshLabel(cell) {
    const idx = cells.indexOf(cell);
    if (idx < 0 || !cell.labelEl) return;
    const firstLine = (cell.content || '').split('\n')[0].slice(0, 60) || '(empty)';
    cell.labelEl.innerHTML =
      `<span class="label-idx">[${idx + 1}]:</span> ${escapeHtml(firstLine)}`;
  }

  function refreshAllLabels() {
    for (const cell of cells) refreshLabel(cell);
  }

  async function onRunClick(id) {
    const settings = await Anb.settings.load();
    await runCell(id, settings);
    setCellPreview(id, true);
  }

  async function handleShiftEnter(id) {
    const settings = await Anb.settings.load();
    await runCell(id, settings);

    const idx = cells.findIndex((c) => c.id === id);
    if (idx < 0) return;

    if (idx + 1 < cells.length) {
      // Focus the next cell FIRST (while the current cell is still in
      // edit mode, so the layout hasn't shifted), then collapse the
      // current cell to preview. Doing it the other way around — hide
      // the wrapper first, then focus — sometimes causes the browser
      // to lose the focus target and scroll the page to the top.
      editor.focus(cells[idx + 1].cm);
      setCellPreview(id, true);
    } else {
      setCellPreview(id, true);
      addCell('below', idx);
    }
  }

  // --- preview / edit mode toggle ------------------------------------------

  function applyCellMode(cell) {
    if (!cell) return;
    const wrapper = cell.cm ? editor.getWrapper(cell.cm) : null;
    if (cell.previewMode) {
      if (wrapper) wrapper.style.display = 'none';
      if (cell.previewEl) {
        cell.previewEl.innerHTML = renderMarkdown(cell.content || '');
        cell.previewEl.style.display = 'block';
      }
      if (cell.toggleBtn) {
        cell.toggleBtn.textContent = '✏';
        cell.toggleBtn.title = 'Edit (back to source)';
      }
    } else {
      if (cell.previewEl) cell.previewEl.style.display = 'none';
      if (wrapper) wrapper.style.display = '';
      if (cell.toggleBtn) {
        cell.toggleBtn.textContent = '👁';
        cell.toggleBtn.title = 'Show preview (rendered markdown)';
      }
      // CodeMirror may need a refresh after being un-hidden
      if (cell.cm) editor.refresh(cell.cm);
    }
  }

  function setCellPreview(id, on) {
    const cell = cells.find((c) => c.id === id);
    if (!cell) return;
    if (cell.previewMode === !!on) return;
    cell.previewMode = !!on;
    applyCellMode(cell);
  }

  function toggleCellPreview(id) {
    const cell = cells.find((c) => c.id === id);
    if (!cell) return;
    cell.previewMode = !cell.previewMode;
    applyCellMode(cell);
  }

  // --- drag & drop reordering ----------------------------------------------

  let dragSourceId = null;

  function onDragStart(e, cellId) {
    dragSourceId = cellId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cellId);
    setTimeout(() => {
      const cell = cells.find((c) => c.id === cellId);
      if (cell && cell.cellEl) cell.cellEl.classList.add('cell-dragging');
    }, 0);
  }

  function onDragOver(e, cellId) {
    if (!dragSourceId || dragSourceId === cellId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const cell = cells.find((c) => c.id === cellId);
    if (!cell || !cell.cellEl) return;

    const rect = cell.cellEl.getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;

    clearDropIndicators();
    cell.cellEl.classList.add(isAbove ? 'cell-drop-above' : 'cell-drop-below');
  }

  function onDragLeave(e, cellId) {
    const cell = cells.find((c) => c.id === cellId);
    if (!cell || !cell.cellEl) return;
    cell.cellEl.classList.remove('cell-drop-above', 'cell-drop-below');
  }

  function onDrop(e, targetId) {
    e.preventDefault();
    if (!dragSourceId || dragSourceId === targetId) {
      cleanupDrag();
      return;
    }

    const sourceIdx = cells.findIndex((c) => c.id === dragSourceId);
    const targetIdx = cells.findIndex((c) => c.id === targetId);
    if (sourceIdx < 0 || targetIdx < 0) {
      cleanupDrag();
      return;
    }

    const targetCell = cells[targetIdx];
    const rect = targetCell.cellEl.getBoundingClientRect();
    const isAbove = e.clientY < rect.top + rect.height / 2;

    const [source] = cells.splice(sourceIdx, 1);
    let insertAt = cells.findIndex((c) => c.id === targetId);
    if (!isAbove) insertAt += 1;
    cells.splice(insertAt, 0, source);

    cleanupDrag();
    rerenderAll();
    saveNotebookDebounced();

    const moved = cells.find((c) => c.id === dragSourceId);
    if (moved && moved.cm) {
      setTimeout(() => editor.focus(moved.cm), 50);
    }
  }

  function onDragEnd() {
    cleanupDrag();
  }

  function clearDropIndicators() {
    for (const c of cells) {
      if (c.cellEl) c.cellEl.classList.remove('cell-drop-above', 'cell-drop-below');
    }
  }

  function cleanupDrag() {
    for (const c of cells) {
      if (c.cellEl) {
        c.cellEl.classList.remove('cell-dragging', 'cell-drop-above', 'cell-drop-below');
      }
    }
    dragSourceId = null;
  }

  // --- markdown rendering ---------------------------------------------------

  function renderMarkdown(text) {
    if (!text) return '';
    try {
      if (typeof marked !== 'undefined') {
        marked.setOptions({
          breaks: true,
          gfm: true,
          highlight: (code, lang) => {
            if (
              typeof hljs !== 'undefined' &&
              lang &&
              hljs.getLanguage(lang)
            ) {
              try {
                return hljs.highlight(code, { language: lang }).value;
              } catch {
                /* fall through */
              }
            }
            return escapeHtml(code);
          }
        });

        let html = marked.parse(text);

        // KaTeX auto-render: walk the parsed HTML, find $...$ / $$...$$ in
        // text nodes, and replace with rendered math. Skips <code>/<pre>
        // automatically so inline code with literal `$` stays untouched.
        if (typeof window.renderMathInElement === 'function') {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = html;
          try {
            window.renderMathInElement(wrapper, {
              delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$',  right: '$',  display: false }
              ],
              throwOnError: false,
              // Don't double-render math that's already been KaTeX-processed
              ignoredClasses: ['katex']
            });
            html = wrapper.innerHTML;
          } catch (err) {
            console.warn('KaTeX render failed:', err);
          }
        }

        return html;
      }
    } catch (err) {
      console.warn('marked parse failed:', err);
    }
    return `<pre>${escapeHtml(text)}</pre>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeFilename(name) {
    const cleaned = String(name == null ? '' : name)
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_') // illegal on Windows / macOS
      .replace(/^\.+/, '')                     // no leading dots (hidden files)
      .replace(/\.+$/, '')                     // no trailing dots
      .trim();
    return cleaned || 'untitle';
  }

  // --- expose ---------------------------------------------------------------

  Anb.cells = {
    init,
    getCells,
    render,
    addCell,
    deleteCell,
    clearAllOutputs,
    clearCellOutput,
    runCell,
    runAll,
    exportNotebook,
    exportNotebookHtml,
    exportNotebookAgent,
    toggleCellPreview,
    setCellPreview
  };
})();
