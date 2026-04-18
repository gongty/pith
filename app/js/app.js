/* ── Main entry point ── */
import { $, go } from './utils.js';
import { initLang, applyI18n, setLang } from './i18n.js';
import state from './state.js';
import { initTheme, toggleTheme } from './theme.js';
import { toggleSidebar, initSidebar, initSidebarPreview, toggleFold, toggleDateFold, switchSidebarTab } from './sidebar.js';
import { toggleDD, pickModel } from './composer.js';
import { openSearch, closeSearch, searchFor, handleSearchKeydown, initSearchInput } from './search.js';
import { openSettings, closeSettings, onProvChange, saveSett, testConn, switchSettingsTab, initSidebarTitle } from './settings.js';
import { openIngest, closeIngest, submitIngest, batchToggleAll, batchFileToggle, initIngestDragDrop, checkActiveIngest, removeIngestUrl } from './ingest.js';
import { initIngestQueue, toggleIngestQueue, openIngestQueue } from './ingest-queue.js';
import { render } from './router.js';
import { dashAsk } from './pages/dashboard.js';
import { chatSend, delChat, archiveChat, precipitateMsg, precipitateConv, closePrecipModal } from './pages/chat.js';
import { toggleToc, scrollToH, onArtChange, fmtCmd, closeDel, doDel, requestDelArticle, newArticle, pickSlash, closeSlashMenu, imgAlign, imgSize, deselectImg, closeArticleQA, sendArticleQA, qaChip, toggleQAModelDD, qaModelPick } from './pages/article.js';
import { gZoom, applyGF } from './pages/graph.js';
import { markAllArticlesRead } from './pages/browse.js';
import { openAutotaskModal, closeAutotaskModal, closeAutotaskDetail, runAutotask, toggleAutotaskEnabled, deleteAutotask, switchAutotaskTab, switchHistoryRange, backToWizardStep1, toggleWizardAdvanced, submitConfigureIntent, pickAutotaskIntentPreset, confirmCreateTask, openSourcePicker, closeSourcePicker, confirmSourcePicker, submitFeedback, addSourceToDraft, removeSourceFromDraft, removeMustExclude, toggleRunExpand, toggleTaskExpand } from './pages/autotask.js';

/* ── Expose functions to inline onclick handlers ── */
window.go = go;
window.$ = $;
window.setLang = setLang;
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
window.archiveChat = archiveChat;
window.toggleToc = toggleToc;
window.scrollToH = scrollToH;
window.onArtChange = onArtChange;
window.fmtCmd = fmtCmd;
window.closeDel = closeDel;
window.doDel = doDel;
window.requestDelArticle = requestDelArticle;
window.newArticle = newArticle;
window.pickSlash = pickSlash;
window.closeSlashMenu = closeSlashMenu;
window.toggleFold = toggleFold;
window.toggleDateFold = toggleDateFold;
window.switchSidebarTab = switchSidebarTab;
window.gZoom = gZoom;
window.applyGF = applyGF;
window.markAllArticlesRead = markAllArticlesRead;
window.precipitateMsg = precipitateMsg;
window.precipitateConv = precipitateConv;
window.closePrecipModal = closePrecipModal;
window.switchSettingsTab = switchSettingsTab;
window.submitIngest = submitIngest;
window.batchToggleAll = batchToggleAll;
window.removeIngestUrl = removeIngestUrl;
window.batchFileToggle = batchFileToggle;
window.toggleIngestQueue = toggleIngestQueue;
window.imgAlign = imgAlign;
window.imgSize = imgSize;
window.deselectImg = deselectImg;
window.closeArticleQA = closeArticleQA;
window.sendArticleQA = sendArticleQA;
window.qaChip = qaChip;
window.toggleQAModelDD = toggleQAModelDD;
window.qaModelPick = qaModelPick;
window.openAutotaskModal = openAutotaskModal;
window.closeAutotaskModal = closeAutotaskModal;
window.closeAutotaskDetail = closeAutotaskDetail;
window.runAutotask = runAutotask;
window.toggleAutotaskEnabled = toggleAutotaskEnabled;
window.deleteAutotask = deleteAutotask;
window.switchAutotaskTab = switchAutotaskTab;
window.switchHistoryRange = switchHistoryRange;
window.backToWizardStep1 = backToWizardStep1;
window.toggleWizardAdvanced = toggleWizardAdvanced;
window.submitConfigureIntent = submitConfigureIntent;
window.pickAutotaskIntentPreset = pickAutotaskIntentPreset;
window.confirmCreateTask = confirmCreateTask;
window.openSourcePicker = openSourcePicker;
window.closeSourcePicker = closeSourcePicker;
window.confirmSourcePicker = confirmSourcePicker;
window.submitFeedback = submitFeedback;
window.addSourceToDraft = addSourceToDraft;
window.removeSourceFromDraft = removeSourceFromDraft;
window.removeMustExclude = removeMustExclude;
window.toggleRunExpand = toggleRunExpand;
window.toggleTaskExpand = toggleTaskExpand;

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
  document.querySelectorAll('.article-qa-model-dd.open').forEach(dd => {
    if (!dd.contains(e.target) && !e.target.closest('.article-qa-model-tag')) dd.classList.remove('open');
  });
});

/* ── Global keyboard shortcuts ── */
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); go('#/'); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'i') { e.preventDefault(); openIngest(); }
  if (e.key === 'Escape') { closeSearch(); closeIngest(); closeSettings(); closeDel(); closePrecipModal(); deselectImg(); closeSourcePicker(); closeAutotaskModal(); closeAutotaskDetail(); }
  handleSearchKeydown(e);
});

/* ── Init ── */
initLang();
applyI18n();
initTheme();
initSidebar();
initSidebarTitle();
initSearchInput();
initIngestDragDrop();
initSidebarPreview();
checkActiveIngest();
initIngestQueue();
window.addEventListener('hashchange', render);
render();
