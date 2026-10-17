let existingIds = [];
let existingRows = [];
let inputFilename = '';
let pollTimer = null;

const fileArea = document.getElementById('fileArea');
const csvFile = document.getElementById('csvFile');
const startBtn = document.getElementById('startBtn');
const statusMsg = document.getElementById('statusMsg');
const progressArea = document.getElementById('progressArea');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');
const progressDetail = document.getElementById('progressDetail');
const fullScanCheck = document.getElementById('fullScan');

fileArea.addEventListener('click', () => csvFile.click());

csvFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  inputFilename = file.name;
  const reader = new FileReader();
  reader.onload = (ev) => {
    // 旧形式（タイトル,サークル名,声優,…）も CSVShelf 形式も読める。
    const items = CSVTools.readItems(ev.target.result);
    existingIds = [];
    existingRows = [];
    for (const it of items) {
      const m = it.url.match(/product_id=([\w]+)/);
      if (!m) continue;
      existingIds.push(m[1]);
      existingRows.push(it);
    }
    fileArea.textContent = `✅ ${file.name}（既存${existingIds.length}件）`;
    fileArea.classList.add('loaded');
    setStatus(`既存CSVを読み込みました（${existingIds.length}件）`);
  };
  reader.readAsText(file, 'UTF-8');
});

startBtn.addEventListener('click', async () => {
  const limit = parseInt(document.getElementById('limit').value) || 0;
  const fullScan = fullScanCheck.checked;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes('dmm.co.jp')) {
    setStatus('DMMのページを開いてから実行してください', 'error');
    return;
  }
  startBtn.disabled = true;
  progressArea.classList.add('active');
  setProgress(
    fullScan ? '🔄 全件スキャン中...' : '🔄 スクロール中...',
    'ライブラリを読み込んでいます',
    0
  );
  setStatus('');
  chrome.runtime.sendMessage({ type: 'START', existingIds, existingRows, limit, fullScan, inputFilename });
  startPolling();
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_PROGRESS' }, (p) => {
      if (!p) return;
      updateUI(p);
      if (p.phase === 'done' || p.phase === 'error') {
        clearInterval(pollTimer);
        startBtn.disabled = false;
      }
    });
  }, 800);
}

function updateUI(p) {
  if (p.phase === 'idle') return;
  progressArea.classList.add('active');
  if (p.phase === 'scrolling') {
    setProgress('🔄 スクロール中...', 'ライブラリを読み込んでいます', 0);
  } else if (p.phase === 'fetching_cv') {
    const pct = Math.round(p.cvCurrent / p.cvTotal * 100);
    setProgress(
      `🎤 声優情報取得中... (${p.cvCurrent}/${p.cvTotal})`,
      p.currentTitle + (p.currentTitle.length >= 30 ? '…' : ''),
      pct
    );
  } else if (p.phase === 'done') {
    setProgress('🎉 完了！', p.message, 100);
    setStatus(p.message, 'success');
  } else if (p.phase === 'error') {
    setProgress('❌ エラー', p.error, 0);
    setStatus(p.error, 'error');
  }
}

function setProgress(label, detail, pct) {
  progressLabel.textContent = label;
  progressDetail.textContent = detail;
  progressBar.style.width = Math.min(100, pct) + '%';
}

function setStatus(msg, type = '') {
  statusMsg.textContent = msg;
  statusMsg.className = type;
}

chrome.runtime.sendMessage({ type: 'GET_PROGRESS' }, (p) => {
  if (!p || p.phase === 'idle') return;
  progressArea.classList.add('active');
  updateUI(p);
  if (p.phase !== 'done' && p.phase !== 'error') {
    startBtn.disabled = true;
    startPolling();
  }
});
