/* Shared mutable state */
const state = {
  gd: null,       // graph data
  td: null,       // tree data
  sd: null,       // stats data
  cv: '',         // current view
  gaf: null,      // graph animation frame
  st: null,       // search timer
  ipt: null,      // ingest poll timer
  convId: null,   // current conversation id
  msgs: [],       // current chat messages
  chatBusy: false,
  artPath: '',    // current article path
  artMd: '',      // current article markdown
  saveT: null,    // save timer
  sCache: null,   // settings cache
  chatList: null, // cached chat list
  searchIdx: -1,
  undoTimer: null,
  undoData: null,
  foldedTopics: new Set(),
  foldedDates: new Set(),
  batchFiles: [], // [{name,content,checked}]
  gs: null,       // graph state
  pendingModel: null,        // {provider, model} 暂存用户切换，尚未创建会话时
  currentConvOverride: null, // {provider, model} 当前会话覆盖，用于 composer 展示
};

export default state;
