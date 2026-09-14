// ============================================================
// llm.js — OpenAI-compatible streaming chat completion
// (attaches to window.Anb.llm)
// ============================================================

window.Anb = window.Anb || {};

(function () {
  /**
   * Stream a chat completion from an OpenAI-compatible endpoint.
   *
   * @param {Object} opts
   * @param {string} opts.baseUrl
   * @param {string} opts.apiKey
   * @param {string} opts.model
   * @param {Array}  opts.messages
   * @param {Function} opts.onChunk   (delta, accumulated) => void
   * @param {Function} opts.onDone    (accumulated) => void
   * @param {Function} opts.onError   (err) => void
   * @param {AbortSignal} [opts.signal]
   */
  async function streamChatCompletion(opts) {
    const { baseUrl, apiKey, model, messages, onChunk, onDone, onError, signal } = opts;

    if (!apiKey) {
      onError(new Error('Missing API Key — open ⚙ Settings to set it.'));
      return;
    }
    if (!baseUrl) {
      onError(new Error('Missing Base URL — open ⚙ Settings to set it.'));
      return;
    }
    if (!model) {
      onError(new Error('Missing Model — open ⚙ Settings to set it.'));
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      onError(new Error('No messages to send.'));
      return;
    }

    const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        onError(new Error('Request aborted.'));
      } else {
        onError(new Error(`Network error: ${err.message || err}`));
      }
      return;
    }

    if (!response.ok) {
      let errMsg = `HTTP ${response.status} ${response.statusText}`;
      try {
        const errBody = await response.json();
        if (errBody.error && errBody.error.message) {
          errMsg = errBody.error.message;
        } else if (errBody.message) {
          errMsg = errBody.message;
        }
      } catch {
        try {
          const txt = await response.text();
          if (txt) errMsg = txt.slice(0, 200);
        } catch {}
      }
      onError(new Error(errMsg));
      return;
    }

    if (!response.body) {
      onError(new Error('Response has no body — streaming not supported?'));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulated = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            onDone(accumulated);
            return;
          }

          let obj;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }

          if (obj.error) {
            const msg = obj.error.message || obj.error.code || JSON.stringify(obj.error);
            onError(new Error(`API error: ${msg}`));
            return;
          }

          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            accumulated += delta;
            onChunk(delta, accumulated);
          }
        }
      }
      onDone(accumulated);
    } catch (err) {
      if (err.name === 'AbortError') {
        onError(new Error('Request aborted.'));
      } else {
        onError(new Error(`Stream interrupted: ${err.message || err}`));
      }
    }
  }

  window.Anb.llm = { streamChatCompletion };
})();
