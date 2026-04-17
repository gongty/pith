/* ── Fetch-based SSE client ──
 * 原生 EventSource 只支持 GET。本封装支持 POST + JSON body，
 * 通过 fetch stream + TextDecoder 解析 `event: <name>\ndata: <json>\n\n` 块。
 *
 * 用法：
 *   const handle = openSSE('/api/wiki/ask', {
 *     body: { question, clarifyAnswers },
 *     onEvent: (name, data) => { ... },
 *     onDone: () => { ... },
 *     onError: (err) => { ... }
 *   });
 *   handle.abort();   // 中止流
 */

export function openSSE(url, {
  method = 'POST',
  headers = {},
  body,
  onEvent,
  onDone,
  onError,
  signal
} = {}) {
  const controller = new AbortController();
  // 若外部传入 signal，链式 abort
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const finalHeaders = Object.assign(
    { 'Accept': 'text/event-stream' },
    body != null ? { 'Content-Type': 'application/json' } : {},
    headers
  );

  (async () => {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: finalHeaders,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (onError) onError(err);
      return;
    }
    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      if (onError) onError(new Error('HTTP ' + response.status + (txt ? ': ' + txt.slice(0, 200) : '')));
      return;
    }
    // 若响应不是 SSE（例如 clarify 阶段返回 JSON），把它当普通 JSON 处理
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/event-stream')) {
      try {
        const data = await response.json();
        if (onEvent) onEvent('__json__', data);
        if (onDone) onDone();
      } catch (err) {
        if (onError) onError(err);
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          parseAndDispatch(chunk, onEvent, onError);
        }
      }
      // flush 残余
      buf += decoder.decode();
      if (buf.trim()) parseAndDispatch(buf, onEvent, onError);
      if (onDone) onDone();
    } catch (err) {
      if (controller.signal.aborted) return;
      if (onError) onError(err);
    }
  })();

  return { abort: () => controller.abort() };
}

function parseAndDispatch(chunk, onEvent, onError) {
  let eventName = 'message';
  let dataStr = '';
  for (const rawLine of chunk.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith(':')) continue; // SSE 注释
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // 多行 data: 累加（按 SSE 规范以 \n 连接，但这里协议是单行 JSON，保险起见拼接）
      dataStr += (dataStr ? '\n' : '') + line.slice(5).trim();
    }
  }
  if (!dataStr) return;
  let data;
  try { data = JSON.parse(dataStr); }
  catch (err) {
    if (onError) onError(new Error('SSE JSON 解析失败: ' + err.message + ' / raw=' + dataStr.slice(0, 200)));
    return;
  }
  if (onEvent) onEvent(eventName, data);
}
