// ============================================================
// editor.js — CodeMirror 5 wrapper (attaches to window.Anb.editor)
// ============================================================

window.Anb = window.Anb || {};

(function () {
  const CM_THEME_DARK = 'dracula';
  const CM_THEME_LIGHT = 'default';

  // ---------------------------------------------------------------------
  // TeX inline overlay mode — highlights $...$ (inline) and $$...$$ (display)
  // math regions, plus \command tokens inside math. Combined with the
  // markdown mode via CodeMirror.overlayMode (loaded as an addon).
  // ---------------------------------------------------------------------
  if (typeof CodeMirror !== 'undefined') {
    try {
      CodeMirror.defineMode('tex-inline-overlay', function () {
        return {
          startState: function () {
            return { inMath: false, inDisplay: false };
          },
          copyState: function (s) {
            return { inMath: s.inMath, inDisplay: s.inDisplay };
          },
          token: function (stream, state) {
            // --- Outside any math block ---
            if (!state.inMath && !state.inDisplay) {
              if (stream.match('$$', false)) {
                stream.next(); stream.next();
                state.inDisplay = true;
                return 'keyword';
              }
              if (stream.peek() === '$') {
                stream.next();
                state.inMath = true;
                return 'keyword';
              }
              // Skip to the next '$' (or end of line) without emitting a token —
              // let the underlying markdown mode handle the skipped range.
              const nextDollar = stream.string.indexOf('$', stream.pos);
              if (nextDollar === -1) stream.skipToEnd();
              else stream.pos = nextDollar;
              return null;
            }

            // --- Inside $$ ... $$ (display math) ---
            if (state.inDisplay) {
              if (stream.match('$$')) {
                state.inDisplay = false;
                return 'keyword';
              }
              if (stream.match(/\\[a-zA-Z]+/)) return 'variable-2';
              if (stream.match(/[{}]/))         return 'bracket';
              stream.next();
              return 'string-2';
            }

            // --- Inside $ ... $ (inline math) ---
            if (state.inMath) {
              if (stream.peek() === '$') {
                stream.next();
                state.inMath = false;
                return 'keyword';
              }
              if (stream.match(/\\[a-zA-Z]+/)) return 'variable-2';
              if (stream.match(/[{}]/))         return 'bracket';
              stream.next();
              return 'string-2';
            }
          }
        };
      });
    } catch (e) {
      // already defined — ignore
    }
  }

  function getCurrentCMTheme() {
    return document.documentElement.dataset.theme === 'light' ? CM_THEME_LIGHT : CM_THEME_DARK;
  }

  function createEditor(parent, initialValue = '') {
    // Combine markdown (base) + tex-inline-overlay so that $...$ and $$...$$
    // regions are syntax-highlighted in addition to normal markdown.
    const baseMode = CodeMirror.getMode({}, 'markdown');
    const texMode = CodeMirror.getMode({}, 'tex-inline-overlay');
    const combinedMode =
      typeof CodeMirror.overlayMode === 'function'
        ? CodeMirror.overlayMode(baseMode, texMode)
        : baseMode;

    const cm = CodeMirror(parent, {
      value: initialValue,
      mode: combinedMode,
      theme: getCurrentCMTheme(),
      lineNumbers: true,
      lineWrapping: true,
      indentUnit: 2,
      tabSize: 2,
      extraKeys: {
        // Shift+Enter: emit a custom bubbling event the cells module handles.
        // We use a custom DOM event so Shift+Enter doesn't just insert a newline.
        'Shift-Enter': (cm) => {
          const evt = new CustomEvent('cell:shift-enter', { bubbles: true });
          cm.getWrapperElement().dispatchEvent(evt);
        }
      }
    });

    return cm;
  }

  function getValue(cm) {
    return cm.getValue();
  }

  function setValue(cm, value) {
    cm.setValue(value);
  }

  function focus(cm) {
    if (cm.getWrapperElement().offsetParent !== null) {
      cm.focus();
    } else {
      setTimeout(() => cm.focus(), 50);
    }
  }

  function setTheme(cm, theme) {
    cm.setOption('theme', theme);
  }

  function refresh(cm) {
    cm.refresh();
  }

  function onChange(cm, handler) {
    cm.on('change', (instance) => {
      handler(instance.getValue());
    });
  }

  function getWrapper(cm) {
    return cm.getWrapperElement();
  }

  window.Anb.editor = {
    getCurrentCMTheme,
    createEditor,
    getValue,
    setValue,
    focus,
    setTheme,
    refresh,
    onChange,
    getWrapper
  };
})();
