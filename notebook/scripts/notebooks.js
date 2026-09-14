// ============================================================
// notebooks.js — Notebook index management (multi-notebook)
// (attaches to window.Anb.notebooks)
// ============================================================
//
// Owns the IndexedDB-backed index of notebooks and which one is
// currently open. The cells module (cells.js) reads/writes the
// cells of the *current* notebook through getCurrentCells() /
// setCurrentCells().
//
// IndexedDB schema (replacing the old single `notebook` key):
//   { key: 'notebooks',         value: { [id]: { id, name, cells, createdAt, updatedAt } } }
//   { key: 'currentNotebookId', value: 'nb-xxx' }
//
// Migration: on first run after upgrade, if the legacy `notebook`
// key still exists, its cells are wrapped in a new "Imported
// Notebook" entry and the old key is deleted.

window.Anb = window.Anb || {};

(function () {
  const Anb = window.Anb;

  let allNotebooks = {}; // { [id]: { id, name, cells, createdAt, updatedAt } }
  let currentNotebookId = null;
  let onChangeCb = null;

  async function init({ onChange } = {}) {
    onChangeCb = onChange || null;
    await Anb.storage.init();

    // ---- Migration: legacy `notebook` key → first entry of `notebooks` ----
    const legacy = await Anb.storage.get('notebook');
    if (legacy && Array.isArray(legacy.cells)) {
      const id = newId();
      allNotebooks[id] = {
        id,
        name: 'Imported Notebook',
        cells: legacy.cells,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      currentNotebookId = id;
      await Anb.storage.set('notebooks', allNotebooks);
      await Anb.storage.set('currentNotebookId', currentNotebookId);
      await Anb.storage.del('notebook');
      return;
    }

    // ---- Normal path: load existing index ----
    allNotebooks = (await Anb.storage.get('notebooks')) || {};
    currentNotebookId = await Anb.storage.get('currentNotebookId');

    // First-ever run, or the currentNotebookId was deleted out from under us
    if (!currentNotebookId || !allNotebooks[currentNotebookId]) {
      const id = newId();
      allNotebooks[id] = makeBlankNotebook(id, 'untitle');
      currentNotebookId = id;
      await Anb.storage.set('notebooks', allNotebooks);
      await Anb.storage.set('currentNotebookId', currentNotebookId);
    }
  }

  // --- read-side ----------------------------------------------------------

  function getCurrent() {
    return allNotebooks[currentNotebookId] || null;
  }

  function getCurrentCells() {
    const nb = getCurrent();
    return nb ? nb.cells.slice() : [];
  }

  function getName() {
    const nb = getCurrent();
    return nb ? nb.name : 'untitle';
  }

  function getId() {
    return currentNotebookId;
  }

  // [{ id, name, cellCount, updatedAt, isCurrent }], most recent first
  function list() {
    return Object.values(allNotebooks)
      .map((nb) => ({
        id: nb.id,
        name: nb.name,
        cellCount: nb.cells.length,
        updatedAt: nb.updatedAt,
        isCurrent: nb.id === currentNotebookId
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // --- write-side (current notebook) --------------------------------------

  async function setCurrentCells(cells) {
    const nb = getCurrent();
    if (!nb) return;
    nb.cells = cells;
    nb.updatedAt = Date.now();
    await Anb.storage.set('notebooks', allNotebooks);
    notifyChange();
  }

  async function setCurrentName(name) {
    const nb = getCurrent();
    if (!nb) return;
    const trimmed = (name || '').trim();
    if (!trimmed) return false;
    if (nb.name === trimmed) return true;
    nb.name = trimmed;
    nb.updatedAt = Date.now();
    await Anb.storage.set('notebooks', allNotebooks);
    notifyChange();
    return true;
  }

  // --- write-side (notebook list) -----------------------------------------

  async function createNew(name = 'untitle') {
    const id = newId();
    allNotebooks[id] = makeBlankNotebook(id, name || 'untitle');
    currentNotebookId = id;
    await Anb.storage.set('notebooks', allNotebooks);
    await Anb.storage.set('currentNotebookId', currentNotebookId);
    notifyChange();
    return id;
  }

  async function switchTo(id) {
    if (!allNotebooks[id]) return false;
    currentNotebookId = id;
    await Anb.storage.set('currentNotebookId', currentNotebookId);
    notifyChange();
    return true;
  }

  async function deleteNotebook(id) {
    if (!allNotebooks[id]) return false;
    const wasCurrent = id === currentNotebookId;
    delete allNotebooks[id];
    await Anb.storage.set('notebooks', allNotebooks);

    if (wasCurrent) {
      const remaining = Object.keys(allNotebooks);
      if (remaining.length > 0) {
        currentNotebookId = remaining[0];
        await Anb.storage.set('currentNotebookId', currentNotebookId);
      } else {
        // Always keep at least one notebook alive
        const id2 = newId();
        allNotebooks[id2] = makeBlankNotebook(id2, 'untitle');
        currentNotebookId = id2;
        await Anb.storage.set('notebooks', allNotebooks);
        await Anb.storage.set('currentNotebookId', currentNotebookId);
      }
    }
    notifyChange();
    return true;
  }

  // --- import from JSON file ----------------------------------------------

  async function importFromData(data, defaultName) {
    if (!data || !Array.isArray(data.cells)) return null;
    const valid = data.cells.every(
      (c) =>
        c &&
        typeof c === 'object' &&
        typeof c.id === 'string' &&
        typeof c.content === 'string' &&
        typeof c.output === 'string'
    );
    if (!valid) return null;

    const id = newId();
    const name =
      (typeof data.name === 'string' && data.name.trim()) ||
      defaultName ||
      `Imported ${new Date().toLocaleDateString()}`;
    allNotebooks[id] = {
      id,
      name,
      cells: data.cells,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    currentNotebookId = id;
    await Anb.storage.set('notebooks', allNotebooks);
    await Anb.storage.set('currentNotebookId', currentNotebookId);
    notifyChange();
    return id;
  }

  // --- helpers ------------------------------------------------------------

  function makeBlankNotebook(id, name) {
    return {
      id,
      name,
      cells: [
        { id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, content: '', output: '' }
      ],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  function newId() {
    return `nb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function notifyChange() {
    if (onChangeCb) {
      try {
        onChangeCb();
      } catch (err) {
        console.error('notebooks: onChange handler error:', err);
      }
    }
  }

  Anb.notebooks = {
    init,
    getCurrent,
    getCurrentCells,
    getName,
    getId,
    list,
    setCurrentCells,
    setCurrentName,
    createNew,
    switchTo,
    deleteNotebook,
    importFromData
  };
})();
