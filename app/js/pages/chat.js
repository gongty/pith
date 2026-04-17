import { $, h, api, post, put, apiDel, toast, go, skelLines, typeEffect, jsAttr } from '../utils.js';
import state from '../state.js';
import { buildComposer, initComposer } from '../composer.js';
import { fmtChat } from '../markdown.js';
import { updSidebarChats } from '../sidebar.js';

export async function rChatList(c) {
  c.innerHTML = '<div class="page-chat-list">' + skelLines(5) + '</div>';
  try {
    const raw = await api('/api/chat/list');
    const list = Array.isArray(raw) ? raw : (raw && raw.conversations) || [];
    state.chatList = list;
    let s = '<div class="page-chat-list"><div class="chat-list-heading">对话</div>';
    if (!list.length) {
      s += '<div class="chat-list-empty"><p style="margin-bottom:4px">还没有对话</p><p style="font-size:12px;color:var(--fg-tertiary);margin-bottom:14px">开始你的第一个提问，AI 会结合知识库内容回答</p><button class="btn-fill" style="width:auto;padding:8px 20px" onclick="go(\'#/\')">开始提问</button></div>';
    } else {
      list.forEach(ch => {
        const d = ch.updatedAt ? new Date(ch.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
        s += '<div class="chat-list-item" onclick="go(\'#/chat/' + jsAttr(ch.id) + '\')">';
        s += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
        s += '<div class="chat-list-item-info"><div class="chat-list-item-title">' + h(ch.title) + '</div><div class="chat-list-item-date">' + d + '</div></div>';
        s += '<button class="chat-list-item-del" onclick="event.stopPropagation();delChat(\'' + jsAttr(ch.id) + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>';
        s += '</div>';
      });
    }
    s += '</div>'; c.innerHTML = s;
  } catch (e) { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败</div>'; }
}

export async function delChat(id) {
  try { await apiDel('/api/chat/' + id); state.chatList = null; toast('已归档'); window.render(); } catch { toast('归档失败'); }
}
export { delChat as archiveChat };

export async function rChat(c, id) {
  if (!id) {
    state.convId = null;
    // 新会话没有持久化 override，清掉以免串色到 composer
    state.currentConvOverride = null;
    if (state.pendingChat) {
      const text = state.pendingChat;
      state.pendingChat = null;
      state.msgs = [{ role: 'user', content: text }];
      renderChatPage(c);
      sendNewChat(text);
      return;
    }
    state.msgs = [];
    renderChatPage(c);
    return;
  }
  c.innerHTML = '<div class="page-chat"><div class="chat-messages"><div class="chat-messages-inner">' + skelLines(6) + '</div></div></div>';
  // 切会话时必须先对比再覆盖 convId：原先是 `state.convId = id; if (state.convId !== id)`，
  // 条件恒为 false，一旦有过消息就再也不重新拉，导致所有对话显示同一份内容（必须刷新页面才恢复）。
  const sameConv = state.convId === id && state.msgs.length > 0;
  state.convId = id;
  try {
    if (!sameConv) {
      const conv = await api('/api/chat/' + id);
      state.msgs = conv.messages || [];
      // 记录本会话偏好模型，供 composer loadModels 展示
      state.currentConvOverride = (conv && (conv.provider || conv.model))
        ? { provider: conv.provider, model: conv.model }
        : null;
    }
    renderChatPage(c);
  } catch (e) { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败: ' + h(e.message) + '</div>'; }
}

function renderChatPage(c) {
  let s = '<div class="page-chat"><div class="chat-messages" id="chatMsgs"><div class="chat-messages-inner">';
  if (!state.msgs.length) {
    s += '<div class="chat-empty-state"><h3>开始新对话</h3><p>基于知识库的内容提问</p>';
    s += '<div class="chat-suggest-cards">';
    s += '<div class="chat-suggest-card" onclick="$(\'cpIn\').value=this.textContent;$(\'cpSendBtn\').disabled=false;chatSend()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>知识库概览</div>';
    s += '<div class="chat-suggest-card" onclick="$(\'cpIn\').value=this.textContent;$(\'cpSendBtn\').disabled=false;chatSend()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>最近更新了什么</div>';
    s += '<div class="chat-suggest-card" onclick="$(\'cpIn\').value=this.textContent;$(\'cpSendBtn\').disabled=false;chatSend()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>总结一篇文章</div>';
    s += '<div class="chat-suggest-card" onclick="$(\'cpIn\').value=this.textContent;$(\'cpSendBtn\').disabled=false;chatSend()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>有哪些主题</div>';
    s += '</div></div>';
  } else state.msgs.forEach(m => s += renderMsg(m));
  s += '</div></div>';
  s += '<div class="chat-bottom"><div class="chat-bottom-inner">' + buildComposer('cp') + '</div></div>';
  s += '</div>';

  // Add topbar buttons
  const topActs = $('topbarActions');
  // Add topbar precipitate-conversation button
  if (topActs && state.convId && state.msgs.length > 0 && !document.getElementById('topbarPrecip')) {
    const pbtn = document.createElement('button');
    pbtn.id = 'topbarPrecip'; pbtn.className = 'topbar-btn'; pbtn.style.color = 'var(--fg-tertiary)';
    pbtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>';
    pbtn.title = '沉淀对话';
    pbtn.onclick = () => precipitateConv();
    topActs.insertBefore(pbtn, topActs.firstChild);
  }

  c.innerHTML = s;
  initComposer('cp', chatSend, state.currentConvOverride);
  const msgsEl = $('chatMsgs'); if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  updSidebarChats();
}

function renderMsg(m) {
  const isUser = m.role === 'user';
  const body = isUser ? h(m.content).replace(/\n/g, '<br>') : fmtChat(m.content);
  let s = '<div class="chat-msg ' + m.role + '">';
  if (isUser) { s += '<div class="chat-msg-body">' + body + '</div>'; }
  else {
    s += '<div class="chat-msg-avatar">AI</div><div class="chat-msg-body">' + body;
    // 显示引用的知识库文章
    if (m.references && m.references.length > 0) {
      s += '<div class="chat-refs">';
      m.references.forEach(r => { s += '<a class="chat-ref" href="#/article/' + h(r.path) + '" title="' + h(r.path) + '">' + h(r.title || r.path) + '</a>'; });
      s += '</div>';
    }
    s += '</div>';
    // Precipitate button (hover-visible) + precipitated badge
    s += '<div class="chat-msg-actions">';
    if (m.precipitated) {
      s += '<a class="precip-badge" href="#/article/' + h(m.precipitated.articlePath) + '" title="' + h(m.precipitated.articleTitle) + '">已沉淀</a>';
    } else if (m.id) {
      s += '<button class="precip-btn" onclick="precipitateMsg(\'' + h(m.id) + '\')" title="沉淀为知识"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg></button>';
    }
    s += '</div>';
  }
  s += '</div>';
  return s;
}

export async function chatSend() {
  const inp = $('cpIn'); const t = inp.value.trim(); if (!t || state.chatBusy) return;
  state.chatBusy = true; $('cpSendBtn').disabled = true;
  const emptyState = document.querySelector('.chat-empty-state'); if (emptyState) emptyState.remove();
  // 为本次发送生成唯一 id，占位符 / AI body 目标 dom id 都带 uid，避免叠发时 getElementById 拿到先前的元素。
  const uid = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const typId = 'chatTyp_' + uid;
  const aiTypId = 'aiTyp_' + uid;
  state.msgs.push({ role: 'user', content: t });
  const msgsEl = $('chatMsgs');
  if (msgsEl) {
    const inner = msgsEl.querySelector('.chat-messages-inner');
    if (inner) {
      inner.innerHTML += renderMsg({ role: 'user', content: t });
      inner.innerHTML += '<div class="chat-msg assistant" id="' + typId + '"><div class="chat-msg-avatar">AI</div><div class="chat-msg-body"><div class="chat-thinking"><span class="thinking-icon">🔍</span> 检索知识库…</div></div></div>';
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  }
  inp.value = ''; inp.style.height = 'auto';
  // 先检索，显示引用来源
  try {
    const sr = await api('/api/search?q=' + encodeURIComponent(t));
    const hits = (Array.isArray(sr) ? sr : sr.results || []).filter(r => !r.path.endsWith('index.md') && !r.path.endsWith('log.md')).slice(0, 5);
    const typ0 = document.getElementById(typId);
    if (typ0 && hits.length > 0) {
      const body = typ0.querySelector('.chat-msg-body');
      if (body) {
        body.innerHTML = '<div class="chat-thinking"><span class="thinking-icon">📖</span> 参考 ' + hits.length + ' 篇文章'
          + '<div class="chat-thinking-refs">' + hits.map(r => '<a href="#/article/' + h(r.path) + '">' + h(r.title || r.path) + '</a>').join('') + '</div>'
          + '</div><div class="chat-typing-dots"><span></span><span></span><span></span></div>';
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }
    } else if (typ0) {
      const body = typ0.querySelector('.chat-msg-body');
      if (body) body.innerHTML = '<div class="chat-thinking"><span class="thinking-icon">💭</span> 思考中…</div><div class="chat-typing-dots"><span></span><span></span><span></span></div>';
    }
  } catch {}
  try {
    if (!state.convId) {
      const body = { firstMessage: t };
      if (state.pendingModel) { Object.assign(body, state.pendingModel); }
      const newRes = await post('/api/chat/new', body);
      state.pendingModel = null;
      state.convId = newRes.conversation.id;
      state.msgs = [{ role: 'user', content: t }, newRes.message];
      state.chatList = null;
      history.replaceState(null, '', '#/chat/' + state.convId);
      updSidebarChats();
      const typ = document.getElementById(typId); if (typ) typ.remove();
      if (msgsEl) { const inner = msgsEl.querySelector('.chat-messages-inner'); if (inner) { inner.innerHTML = state.msgs.map(m => renderMsg(m)).join(''); msgsEl.scrollTop = msgsEl.scrollHeight; } }
      state.chatBusy = false; $('cpSendBtn').disabled = false;
      return;
    }
    const res = await post('/api/chat/' + state.convId + '/message', { content: t });
    state.msgs.push(res.message);
    const typ = document.getElementById(typId);
    if (typ && msgsEl) {
      const msgEl = document.createElement('div');
      msgEl.className = 'chat-msg assistant';
      msgEl.innerHTML = '<div class="chat-msg-avatar">AI</div><div class="chat-msg-body" id="' + aiTypId + '"></div>';
      // Add actions placeholder
      const actionsEl = document.createElement('div');
      actionsEl.className = 'chat-msg-actions';
      actionsEl.style.opacity = '0';
      msgEl.appendChild(actionsEl);
      // 原地替换占位符，保证 AI 回复落在它本次发送对应的位置（叠发时不会串位）。
      typ.replaceWith(msgEl);
      const target = document.getElementById(aiTypId);
      const finalHtml = fmtChat(res.message.content);
      const msg = res.message;
      typeEffect(target, finalHtml, () => {
        target.removeAttribute('id');
        // Append references
        if (msg.references && msg.references.length > 0) {
          let refsHtml = '<div class="chat-refs">';
          msg.references.forEach(r => { refsHtml += '<a class="chat-ref" href="#/article/' + h(r.path) + '" title="' + h(r.path) + '">' + h(r.title || r.path) + '</a>'; });
          refsHtml += '</div>';
          target.insertAdjacentHTML('beforeend', refsHtml);
        }
        // Show precipitate button
        if (msg.id) {
          actionsEl.innerHTML = '<button class="precip-btn" onclick="precipitateMsg(\'' + h(msg.id) + '\')" title="沉淀为知识"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg></button>';
          actionsEl.style.opacity = '';
        }
        msgsEl.scrollTop = msgsEl.scrollHeight;
        // 打字效果结束后再释放 busy 锁，防止期间叠发造成消息顺序错乱。
        state.chatBusy = false;
        const sb = $('cpSendBtn'); if (sb) sb.disabled = false;
      });
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
    state.chatList = null; updSidebarChats();
  } catch (e) {
    const typ = document.getElementById(typId); if (typ) typ.remove();
    if (msgsEl) {
      const inner = msgsEl.querySelector('.chat-messages-inner');
      if (inner) inner.innerHTML += '<div class="chat-msg assistant"><div class="chat-msg-avatar">AI</div><div class="chat-msg-body" style="color:var(--red)">错误: ' + h(e.message) + '</div></div>';
    }
    // 出错分支同步释放，否则按钮永远灰
    state.chatBusy = false; $('cpSendBtn').disabled = false;
  }
}

/* ── Send new chat (from dashboard/search, already navigated) ── */
async function sendNewChat(text) {
  state.chatBusy = true;
  const sendBtn = document.getElementById('cpSendBtn');
  if (sendBtn) sendBtn.disabled = true;
  const msgsEl = $('chatMsgs');
  const uid = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const typId = 'chatTyp_' + uid;
  const aiTypId = 'aiTyp_' + uid;
  // Show retrieval indicator
  if (msgsEl) {
    const inner = msgsEl.querySelector('.chat-messages-inner');
    if (inner) {
      inner.innerHTML += '<div class="chat-msg assistant" id="' + typId + '"><div class="chat-msg-avatar">AI</div><div class="chat-msg-body"><div class="chat-thinking"><span class="thinking-icon">🔍</span> 检索知识库…</div></div></div>';
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  }
  // Prefetch search results to show references
  try {
    const sr = await api('/api/search?q=' + encodeURIComponent(text));
    const hits = (Array.isArray(sr) ? sr : sr.results || []).filter(r => !r.path.endsWith('index.md') && !r.path.endsWith('log.md')).slice(0, 5);
    const typ0 = document.getElementById(typId);
    if (typ0 && hits.length > 0) {
      const body = typ0.querySelector('.chat-msg-body');
      if (body) {
        body.innerHTML = '<div class="chat-thinking"><span class="thinking-icon">📖</span> 参考 ' + hits.length + ' 篇文章'
          + '<div class="chat-thinking-refs">' + hits.map(r => '<a href="#/article/' + h(r.path) + '">' + h(r.title || r.path) + '</a>').join('') + '</div>'
          + '</div><div class="chat-typing-dots"><span></span><span></span><span></span></div>';
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }
    } else if (typ0) {
      const body = typ0.querySelector('.chat-msg-body');
      if (body) body.innerHTML = '<div class="chat-thinking"><span class="thinking-icon">💭</span> 思考中…</div><div class="chat-typing-dots"><span></span><span></span><span></span></div>';
    }
  } catch {}
  try {
    const body = { firstMessage: text };
    if (state.pendingModel) { Object.assign(body, state.pendingModel); }
    const res = await post('/api/chat/new', body);
    state.pendingModel = null;
    state.convId = res.conversation.id;
    state.msgs = [{ role: 'user', content: text }, res.message];
    state.chatList = null;
    history.replaceState(null, '', '#/chat/' + state.convId);
    updSidebarChats();
    const typ = document.getElementById(typId);
    if (typ && msgsEl) {
      const msgEl = document.createElement('div');
      msgEl.className = 'chat-msg assistant';
      msgEl.innerHTML = '<div class="chat-msg-avatar">AI</div><div class="chat-msg-body" id="' + aiTypId + '"></div>';
      const actionsEl = document.createElement('div');
      actionsEl.className = 'chat-msg-actions'; actionsEl.style.opacity = '0';
      msgEl.appendChild(actionsEl);
      // 原地替换占位符，保证 AI 回复落在占位符的位置
      typ.replaceWith(msgEl);
      const target = document.getElementById(aiTypId);
      const finalHtml = fmtChat(res.message.content);
      const msg = res.message;
      typeEffect(target, finalHtml, () => {
        target.removeAttribute('id');
        if (msg.references && msg.references.length > 0) {
          let refsHtml = '<div class="chat-refs">';
          msg.references.forEach(r => { refsHtml += '<a class="chat-ref" href="#/article/' + h(r.path) + '" title="' + h(r.path) + '">' + h(r.title || r.path) + '</a>'; });
          refsHtml += '</div>';
          target.insertAdjacentHTML('beforeend', refsHtml);
        }
        if (msg.id) {
          actionsEl.innerHTML = '<button class="precip-btn" onclick="precipitateMsg(\'' + h(msg.id) + '\')" title="沉淀为知识"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg></button>';
          actionsEl.style.opacity = '';
        }
        msgsEl.scrollTop = msgsEl.scrollHeight;
        // 打字效果结束后再释放 busy 锁
        state.chatBusy = false;
        const sb = document.getElementById('cpSendBtn'); if (sb) sb.disabled = false;
      });
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  } catch (e) {
    const typ = document.getElementById(typId); if (typ) typ.remove();
    if (msgsEl) {
      const inner = msgsEl.querySelector('.chat-messages-inner');
      if (inner) inner.innerHTML += '<div class="chat-msg assistant"><div class="chat-msg-avatar">AI</div><div class="chat-msg-body" style="color:var(--red)">错误: ' + h(e.message) + '</div></div>';
    }
    // 出错分支同步释放
    state.chatBusy = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

/* ── Precipitate (沉淀) ── */
let _precipData = null;

export function precipitateMsg(msgId) {
  const idx = state.msgs.findIndex(m => m.id === msgId);
  if (idx < 0) return;
  const msg = state.msgs[idx];
  const userMsg = idx > 0 && state.msgs[idx - 1].role === 'user' ? state.msgs[idx - 1] : null;
  const preview = (userMsg ? '问：' + userMsg.content.slice(0, 100) + '\n' : '') + '答：' + msg.content.slice(0, 200);
  const msgIds = userMsg ? [userMsg.id, msg.id].filter(Boolean) : [msg.id].filter(Boolean);
  _showPrecipModal(preview, msgIds);
}

export function precipitateConv() {
  if (!state.convId || !state.msgs.length) return;
  const preview = state.msgs.filter(m => m.role !== 'system').slice(0, 4)
    .map(m => (m.role === 'user' ? '问：' : '答：') + m.content.slice(0, 80)).join('\n');
  _showPrecipModal(preview, []);
}

function _showPrecipModal(preview, msgIds) {
  _precipData = { msgIds };
  let modal = document.getElementById('precipModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'precipModal'; modal.className = 'precip-modal-bg'; modal.onclick = e => { if (e.target === modal) closePrecipModal(); }; document.body.appendChild(modal); }
  modal.innerHTML = '<div class="precip-modal-card"><h3>沉淀为知识</h3><div class="precip-preview-label">将沉淀以下内容：</div><pre class="precip-preview">' + h(preview) + '</pre><div class="modal-foot"><button class="btn-outline" onclick="closePrecipModal()">取消</button><button class="btn-sm-fill" onclick="doPrecipitate()">确认沉淀</button></div></div>';
  modal.classList.add('open');
}

export function closePrecipModal() {
  const modal = document.getElementById('precipModal');
  if (modal) modal.classList.remove('open');
  _precipData = null;
}

window.doPrecipitate = async function () {
  if (!_precipData || !state.convId) return;
  const msgIds = _precipData.msgIds;
  closePrecipModal();
  toast('正在沉淀...');
  try {
    const body = msgIds.length ? { messageIds: msgIds } : {};
    const res = await post('/api/chat/' + state.convId + '/precipitate', body);
    if (res.success && res.article) {
      toast('已沉淀为《' + res.article.title + '》');
      // 刷新知识库缓存（图谱、统计等）
      state.gd = null; state.td = null; state.sd = null;
      // Mark messages as precipitated
      for (const mid of (msgIds.length ? msgIds : state.msgs.filter(m => m.role === 'assistant').map(m => m.id).filter(Boolean))) {
        const m = state.msgs.find(x => x.id === mid);
        if (m && m.role === 'assistant') m.precipitated = { articlePath: res.article.path, articleTitle: res.article.title, at: new Date().toISOString() };
        try { await put('/api/chat/' + state.convId + '/message/' + mid + '/mark', { precipitated: { articlePath: res.article.path, articleTitle: res.article.title, at: new Date().toISOString() } }); } catch {}
      }
      // Re-render messages to show badge
      const msgsEl = $('chatMsgs');
      if (msgsEl) { const inner = msgsEl.querySelector('.chat-messages-inner'); if (inner) inner.innerHTML = state.msgs.map(m => renderMsg(m)).join(''); }
    }
  } catch (e) { toast('沉淀失败: ' + e.message); }
};
