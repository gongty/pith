import { $, h, api, post, put, apiDel, toast, go, skelLines, typeEffect } from '../utils.js';
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
      s += '<div class="chat-list-empty"><p style="margin-bottom:12px">还没有对话</p><button class="btn-fill" style="width:auto;padding:8px 20px" onclick="go(\'#/\')">开始提问</button></div>';
    } else {
      list.forEach(ch => {
        const d = ch.updatedAt ? new Date(ch.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
        s += '<div class="chat-list-item" onclick="go(\'#/chat/' + h(ch.id) + '\')">';
        s += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
        s += '<div class="chat-list-item-info"><div class="chat-list-item-title">' + h(ch.title) + '</div><div class="chat-list-item-date">' + d + '</div></div>';
        s += '<button class="chat-list-item-del" onclick="event.stopPropagation();delChat(\'' + h(ch.id) + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>';
        s += '</div>';
      });
    }
    s += '</div>'; c.innerHTML = s;
  } catch (e) { c.innerHTML = '<div style="text-align:center;padding:60px;color:var(--fg-tertiary)">加载失败</div>'; }
}

export async function delChat(id) {
  try { await apiDel('/api/chat/' + id); state.chatList = null; toast('已删除'); window.render(); } catch { toast('删除失败'); }
}

export async function rChat(c, id) {
  if (!id) {
    state.convId = null; state.msgs = [];
    renderChatPage(c);
    return;
  }
  c.innerHTML = '<div class="page-chat"><div class="chat-messages"><div class="chat-messages-inner">' + skelLines(6) + '</div></div></div>';
  state.convId = id;
  try {
    if (!state.msgs.length || state.convId !== id) {
      const conv = await api('/api/chat/' + id);
      state.msgs = conv.messages || [];
      state.convId = id;
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
  const delBtn = document.getElementById('topbarDel');
  if (topActs && !delBtn) {
    const btn = document.createElement('button');
    btn.id = 'topbarDel'; btn.className = 'topbar-btn'; btn.style.color = 'var(--fg-tertiary)';
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>';
    btn.title = '删除对话';
    btn.onclick = () => { delChat(state.convId); go('#/chat'); };
    topActs.insertBefore(btn, topActs.firstChild);
  }
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
  initComposer('cp', chatSend);
  const msgsEl = $('chatMsgs'); if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  updSidebarChats();
}

function renderMsg(m) {
  const isUser = m.role === 'user';
  const body = isUser ? h(m.content).replace(/\n/g, '<br>') : fmtChat(m.content);
  let s = '<div class="chat-msg ' + m.role + '">';
  if (isUser) { s += '<div class="chat-msg-body">' + body + '</div>'; }
  else { s += '<div class="chat-msg-avatar">AI</div><div class="chat-msg-body">' + body + '</div>'; }
  s += '</div>';
  return s;
}

export async function chatSend() {
  const inp = $('cpIn'); const t = inp.value.trim(); if (!t || state.chatBusy) return;
  state.chatBusy = true; $('cpSendBtn').disabled = true;
  const emptyState = document.querySelector('.chat-empty-state'); if (emptyState) emptyState.remove();
  state.msgs.push({ role: 'user', content: t });
  const msgsEl = $('chatMsgs');
  if (msgsEl) {
    const inner = msgsEl.querySelector('.chat-messages-inner');
    if (inner) {
      inner.innerHTML += renderMsg({ role: 'user', content: t });
      inner.innerHTML += '<div class="chat-msg assistant" id="chatTyp"><div class="chat-msg-avatar">AI</div><div class="chat-msg-body"><div class="chat-typing-dots"><span></span><span></span><span></span></div></div></div>';
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  }
  inp.value = ''; inp.style.height = 'auto';
  try {
    if (!state.convId) {
      const newRes = await post('/api/chat/new', { firstMessage: t });
      state.convId = newRes.conversation.id;
      state.msgs = [{ role: 'user', content: t }, newRes.message];
      state.chatList = null;
      history.replaceState(null, '', '#/chat/' + state.convId);
      updSidebarChats();
      const typ = document.getElementById('chatTyp'); if (typ) typ.remove();
      if (msgsEl) { const inner = msgsEl.querySelector('.chat-messages-inner'); if (inner) { inner.innerHTML = state.msgs.map(m => renderMsg(m)).join(''); msgsEl.scrollTop = msgsEl.scrollHeight; } }
      state.chatBusy = false; $('cpSendBtn').disabled = false;
      return;
    }
    const res = await post('/api/chat/' + state.convId + '/message', { content: t });
    state.msgs.push(res.message);
    const typ = document.getElementById('chatTyp'); if (typ) typ.remove();
    if (msgsEl) {
      const inner = msgsEl.querySelector('.chat-messages-inner');
      if (inner) {
        const msgEl = document.createElement('div');
        msgEl.className = 'chat-msg assistant';
        msgEl.innerHTML = '<div class="chat-msg-avatar">AI</div><div class="chat-msg-body" id="aiTypeTarget"></div>';
        inner.appendChild(msgEl);
        const target = document.getElementById('aiTypeTarget');
        const finalHtml = fmtChat(res.message.content);
        typeEffect(target, finalHtml, () => { target.removeAttribute('id'); msgsEl.scrollTop = msgsEl.scrollHeight; });
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }
    }
    state.chatList = null; updSidebarChats();
  } catch (e) {
    const typ = document.getElementById('chatTyp'); if (typ) typ.remove();
    if (msgsEl) {
      const inner = msgsEl.querySelector('.chat-messages-inner');
      if (inner) inner.innerHTML += '<div class="chat-msg assistant"><div class="chat-msg-avatar">AI</div><div class="chat-msg-body" style="color:var(--red)">错误: ' + h(e.message) + '</div></div>';
    }
  }
  state.chatBusy = false; $('cpSendBtn').disabled = false;
}
