/* ── Main entry point ── */
import { $, go } from './utils.js';
import state from './state.js';
import { initTheme, toggleTheme } from './theme.js';
import { toggleSidebar, initSidebar, initSidebarPreview, toggleFold, switchSidebarTab } from './sidebar.js';
import { toggleDD, pickModel } from './composer.js';
import { openSearch, closeSearch, searchFor, handleSearchKeydown, initSearchInput } from './search.js';
import { openSettings, closeSettings, onProvChange, saveSett, testConn, switchSettingsTab } from './settings.js';
import { openIngest, closeIngest, submitIngest, batchToggleAll, batchFileToggle, initIngestDragDrop } from './ingest.js';
import { render } from './router.js';
import { dashAsk } from './pages/dashboard.js';
import { chatSend, delChat, precipitateMsg, precipitateConv, closePrecipModal } from './pages/chat.js';
import { toggleToc, scrollToH, onArtChange, fmtCmd, closeDel, doDel, newArticle } from './pages/article.js';
import { gZoom, applyGF } from './pages/graph.js';

/* ── Expose functions to inline onclick handlers ── */
window.go = go;
window.$ = $;
window.toggleSidebar = toggleSidebar;
window.toggleTheme = () => { toggleTheme(); if (state.cv === 'dashboard' || state.cv === 'graph') render(); };
window.openSearch = openSearch;
window.closeSearch = closeSearch;
window.searchFor = searchFor;
window.openIngest = openIngest;
window.closeIngest = closeIngest;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.onProvChange = onProvChange;
window.saveSett = saveSett;
window.testConn = testConn;
window.toggleDD = toggleDD;
window.pickModel = pickModel;
window.dashAsk = dashAsk;
window.chatSend = chatSend;
window.delChat = delChat;
window.toggleToc = toggleToc;
window.scrollToH = scrollToH;
window.onArtChange = onArtChange;
window.fmtCmd = fmtCmd;
window.closeDel = closeDel;
window.doDel = doDel;
window.newArticle = newArticle;
window.toggleFold = toggleFold;
window.switchSidebarTab = switchSidebarTab;
window.gZoom = gZoom;
window.applyGF = applyGF;
window.precipitateMsg = precipitateMsg;
window.precipitateConv = precipitateConv;
window.closePrecipModal = closePrecipModal;
window.switchSettingsTab = switchSettingsTab;
window.submitIngest = () => submitIngest(render);
window.batchToggleAll = batchToggleAll;
window.batchFileToggle = batchFileToggle;

/* ── Sidebar resize ── */
(function () {
  const handle = $('sidebarResize'), sb = $('sidebar');
  if (!handle || !sb) return;
  let startX, startW;
  handle.addEventListener('mousedown', e => {
    e.preventDefault(); startX = e.clientX; startW = sb.offsetWidth;
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  function onMove(e) { const w = Math.max(180, Math.min(400, startW + (e.clientX - startX))); sb.style.width = w + 'px'; }
  function onUp() { handle.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
})();

/* ── Close dropdowns on outside click ── */
document.addEventListener('click', e => {
  document.querySelectorAll('.chat-model-dropdown.open').forEach(dd => {
    if (!dd.contains(e.target) && !e.target.closest('.chat-model-tag')) dd.classList.remove('open');
  });
});

/* ── Global keyboard shortcuts ── */
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); go('#/'); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'i') { e.preventDefault(); openIngest(); }
  if (e.key === 'Escape') { closeSearch(); closeIngest(); closeSettings(); closeDel(); closePrecipModal(); }
  handleSearchKeydown(e);
});

/* ── Init ── */
initTheme();
initSidebar();
initSearchInput();
initIngestDragDrop();
initSidebarPreview();
window.addEventListener('hashchange', render);
render();
