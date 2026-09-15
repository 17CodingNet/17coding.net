// ============================================================
// main.js — Entry point. Wires top bar, settings, cells, notebooks.
// (No ES modules; attaches to window.Anb)
// ============================================================

(function () {
  const Anb = window.Anb;

  let saveTimer = null;
  let savePending = false; // cells changed since last save

  function debouncedSaveNotebook() {
    savePending = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNotebook, 500);
  }

  async function saveNotebook() {
    saveTimer = null;
    savePending = false;
    const data = Anb.cells.getCells().map((c) => ({
      id: c.id,
      content: c.content,
      output: c.output
    }));
    try {
      await Anb.notebooks.setCurrentCells(data);
    } catch (err) {
      console.error('Failed to save notebook:', err);
    }
  }

  async function main() {
    // 1. Init storage + notebooks (handles legacy → "Imported Notebook" migration)
    await Anb.storage.init();
    await Anb.notebooks.init({
      onChange: () => updateNotebookSlot()
    });

    // 2. Init cells module (wires save callback)
    Anb.cells.init(document.getElementById('notebook'), debouncedSaveNotebook);

    // 3. Load theme
    const savedTheme = await Anb.storage.get('theme');
    applyTheme(savedTheme || 'light');

    // 4. Load & render the current notebook
    Anb.cells.render(Anb.notebooks.getCurrentCells());
    updateNotebookSlot();

    // 5. Settings modal
    Anb.settings.setupModal({
      onSave: (settings) => {
        console.log('[settings] saved', { ...settings, apiKey: '***' });
      }
    });

    // 6. Top-bar buttons
    document.getElementById('btn-add-cell').addEventListener('click', () => {
      Anb.cells.addCell('below', Anb.cells.getCells().length - 1);
    });
    document.getElementById('btn-run-all').addEventListener('click', async () => {
      const settings = await Anb.settings.load();
      await Anb.cells.runAll(settings);
    });
    document.getElementById('btn-clear').addEventListener('click', () => {
      Anb.cells.clearAllOutputs();
    });
    document.getElementById('btn-theme').addEventListener('click', async () => {
      const current = document.documentElement.dataset.theme;
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        await Anb.storage.set('theme', next);
      } catch (err) {
        console.error('Failed to persist theme:', err);
      }
    });

    // Inline rename: click the notebook name
    document.getElementById('current-notebook-name').addEventListener('click', renameCurrentNotebook);

    // 7. Menu actions
    document.querySelectorAll('.menu-items > li[data-action]').forEach((li) => {
      li.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = li.dataset.action;
        const details = li.closest('details');
        if (details) details.removeAttribute('open');
        await handleMenuAction(action);
      });
    });
    // Submenu items (Export ▸)
    document.querySelectorAll('.menu-submenu > li[data-action]').forEach((li) => {
      li.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = li.dataset.action;
        const details = li.closest('details');
        if (details) details.removeAttribute('open');
        await handleMenuAction(action);
      });
    });

    async function handleMenuAction(action) {
      switch (action) {
        case 'new-notebook':
          await actionNewNotebook();
          break;
        case 'open-notebook':
          await actionOpenNotebook();
          break;
        case 'save-notebook':
          await saveNotebook();
          flashStatus(savePending ? 'Nothing to save.' : 'Notebook saved.');
          break;
        case 'import-notebook':
          await actionImportFromJson();
          break;
        case 'export-json':
          Anb.cells.exportNotebook();
          flashStatus('Exported as JSON.');
          break;
        case 'export-html':
          Anb.cells.exportNotebookHtml();
          flashStatus('Exported as HTML.');
          break;
        case 'export-agent':
          await Anb.cells.exportNotebookAgent();
          flashStatus('Exported as agent app.');
          break;
        case 'add-below':
          Anb.cells.addCell('below', Anb.cells.getCells().length - 1);
          break;
        case 'add-above':
          Anb.cells.addCell('above', 0);
          break;
        case 'clear-outputs':
          Anb.cells.clearAllOutputs();
          break;
        default:
          console.warn('Unknown menu action:', action);
      }
    }

    // 8. Open modal close
    document.getElementById('open-cancel').addEventListener('click', hideOpenModal);
    document.getElementById('open-modal').addEventListener('click', (e) => {
      if (e.target.id === 'open-modal') hideOpenModal();
    });

    // 9. Click-outside closes any open <details> menus
    document.addEventListener('click', (e) => {
      document.querySelectorAll('details.menu[open]').forEach((d) => {
        if (!d.contains(e.target)) d.removeAttribute('open');
      });
    });

    // 10. Focus the first cell on load
    const firstCell = Anb.cells.getCells()[0];
    if (firstCell && firstCell.cm) {
      setTimeout(() => Anb.editor.focus(firstCell.cm), 150);
    }
  }

  // --- notebook actions ----------------------------------------------------

  async function actionNewNotebook() {
    // Flush any pending changes for the current notebook first
    await saveNotebook();
    const name = window.prompt('Name for the new notebook:', 'untitle');
    if (name === null) return;
    await Anb.notebooks.createNew(name.trim() || 'untitle');
    Anb.cells.render(Anb.notebooks.getCurrentCells());
    const first = Anb.cells.getCells()[0];
    if (first && first.cm) setTimeout(() => Anb.editor.focus(first.cm), 50);
    flashStatus('New notebook created.');
  }

  async function actionOpenNotebook() {
    // Flush pending changes first
    await saveNotebook();
    showOpenModal();
  }

  async function actionImportFromJson() {
    const hasContent = Anb.cells.getCells().some((c) => c.content.trim() || c.output.trim());
    if (hasContent && !confirm('Import will replace the current notebook. Continue?')) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = JSON.parse(reader.result);
          const id = await Anb.notebooks.importFromData(
            data,
            `Imported ${new Date().toLocaleString()}`
          );
          if (!id) {
            alert('Invalid notebook file: missing or malformed "cells" array.');
            return;
          }
          Anb.cells.render(Anb.notebooks.getCurrentCells());
          const first = Anb.cells.getCells()[0];
          if (first && first.cm) setTimeout(() => Anb.editor.focus(first.cm), 50);
          flashStatus('Notebook imported.');
        } catch (err) {
          alert('Failed to parse JSON: ' + err.message);
        }
      };
      reader.onerror = () => alert('Failed to read file.');
      reader.readAsText(file);
    });
    input.click();
  }

  async function renameCurrentNotebook() {
    const current = Anb.notebooks.getCurrent();
    if (!current) return;
    const next = window.prompt('Rename notebook:', current.name);
    if (next === null) return;
    const ok = await Anb.notebooks.setCurrentName(next);
    if (!ok) {
      alert('Name cannot be empty.');
    }
  }

  function updateNotebookSlot() {
    const el = document.getElementById('current-notebook-name');
    if (!el) return;
    el.textContent = Anb.notebooks.getName();
  }

  // --- Open modal ----------------------------------------------------------

  function showOpenModal() {
    const list = document.getElementById('open-notebook-list');
    const items = Anb.notebooks.list();

    list.innerHTML = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'notebook-empty';
      empty.textContent = 'No saved notebooks yet.';
      list.appendChild(empty);
    } else {
      for (const nb of items) {
        const row = document.createElement('div');
        row.className = 'notebook-row' + (nb.isCurrent ? ' current' : '');
        row.innerHTML = `
          <div class="notebook-row-main" data-id="${escapeAttr(nb.id)}">
            <span class="notebook-row-check">${nb.isCurrent ? '✓' : ''}</span>
            <span class="notebook-row-name">${escapeHtml(nb.name)}</span>
            <span class="notebook-row-meta">${nb.cellCount} cells · ${formatRelative(nb.updatedAt)}</span>
          </div>
          <button class="notebook-row-delete" data-id="${escapeAttr(nb.id)}" title="Delete this notebook" aria-label="Delete notebook">🗑</button>
        `;
        list.appendChild(row);
      }
      list.querySelectorAll('.notebook-row-main').forEach((el) => {
        el.addEventListener('click', async () => {
          const id = el.dataset.id;
          await openAndClose(id);
        });
      });
      list.querySelectorAll('.notebook-row-delete').forEach((el) => {
        el.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = el.dataset.id;
          const items2 = Anb.notebooks.list();
          const nb = items2.find((x) => x.id === id);
          if (!nb) return;
          if (!confirm(`Delete notebook "${nb.name}"? This cannot be undone.`)) return;
          await Anb.notebooks.deleteNotebook(id);
          // The current notebook may have changed (either we deleted it, or another is now current)
          Anb.cells.render(Anb.notebooks.getCurrentCells());
          // Refresh the modal list (the deleted one is gone, and a new current may be marked)
          showOpenModal();
          flashStatus(`Deleted "${nb.name}".`);
        });
      });
    }

    document.getElementById('open-modal').classList.remove('hidden');
  }

  function hideOpenModal() {
    document.getElementById('open-modal').classList.add('hidden');
  }

  async function openAndClose(id) {
    if (id === Anb.notebooks.getId()) {
      hideOpenModal();
      return;
    }
    await Anb.notebooks.switchTo(id);
    Anb.cells.render(Anb.notebooks.getCurrentCells());
    hideOpenModal();
    const first = Anb.cells.getCells()[0];
    if (first && first.cm) setTimeout(() => Anb.editor.focus(first.cm), 50);
    flashStatus(`Opened "${Anb.notebooks.getName()}".`);
  }

  function formatRelative(ts) {
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  // --- theme ---------------------------------------------------------------

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';

    const cmTheme = Anb.editor.getCurrentCMTheme();
    for (const cell of Anb.cells.getCells()) {
      if (cell.cm) Anb.editor.setTheme(cell.cm, cmTheme);
    }
  }

  // --- status flash --------------------------------------------------------

  let statusTimer = null;
  function flashStatus(msg) {
    let statusEl = document.getElementById('status-flash');
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.id = 'status-flash';
      statusEl.style.cssText = `
        position: fixed; bottom: 16px; right: 16px;
        background: var(--accent); color: white;
        padding: 8px 16px; border-radius: 4px;
        font-size: 13px; z-index: 2000;
        box-shadow: var(--shadow);
        opacity: 0; transition: opacity 0.2s;
      `;
      document.body.appendChild(statusEl);
    }
    statusEl.textContent = msg;
    statusEl.style.opacity = '1';
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusEl.style.opacity = '0';
    }, 1800);
  }

  // Expose for debugging / testing if needed
  window.Anb = window.Anb || {};
  window.Anb.main = { applyTheme, saveNotebook, updateNotebookSlot };

  main().catch((err) => {
    console.error('Failed to start AgenticNotebook:', err);
    document.body.innerHTML = `
      <div style="padding:24px;color:#ff6b6b;font-family:monospace;">
        <h2>Failed to start AgenticNotebook</h2>
        <pre>${(err && err.stack) || err}</pre>
      </div>`;
  });
})();
