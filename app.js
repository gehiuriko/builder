(() => {
  'use strict';

  const API_VERSION = '2026-03-10';
  const WORKFLOW_FILE = 'build-apk.yml';
  const MAX_ZIP_BYTES = 32 * 1024 * 1024;
  const $ = (id) => document.getElementById(id);

  const el = {
    settingsButton: $('settingsButton'), setupCard: $('setupCard'), ownerInput: $('ownerInput'), repoInput: $('repoInput'),
    branchInput: $('branchInput'), tokenInput: $('tokenInput'), rememberTokenInput: $('rememberTokenInput'), testButton: $('testButton'),
    saveButton: $('saveButton'), connectionResult: $('connectionResult'), connectionBadge: $('connectionBadge'), fileInput: $('fileInput'),
    dropZone: $('dropZone'), fileTitle: $('fileTitle'), fileMeta: $('fileMeta'), buildButton: $('buildButton'), statusCard: $('statusCard'),
    statusTitle: $('statusTitle'), statusSubtitle: $('statusSubtitle'), statusBadge: $('statusBadge'), progressBar: $('progressBar'),
    steps: $('steps'), logBox: $('logBox'), resultArea: $('resultArea')
  };

  let selectedFile = null;
  let busy = false;
  let currentJobId = null;

  const fmtBytes = (bytes) => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  const makeJobId = () => `job-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;

  function loadConfig() {
    const saved = JSON.parse(localStorage.getItem('azb2-config') || '{}');
    el.ownerInput.value = saved.owner || '';
    el.repoInput.value = saved.repo || 'builder-engine';
    el.branchInput.value = saved.branch || 'main';
    el.rememberTokenInput.checked = Boolean(saved.rememberToken);
    const token = saved.rememberToken ? (localStorage.getItem('azb2-token') || '') : (sessionStorage.getItem('azb2-token') || '');
    el.tokenInput.value = token;
    refreshConnectionBadge();
    if (!saved.owner || !saved.repo || !token) el.setupCard.classList.remove('hidden');
  }

  function getConfig() {
    const owner = el.ownerInput.value.trim();
    const repo = el.repoInput.value.trim();
    const branch = el.branchInput.value.trim() || 'main';
    const token = el.tokenInput.value.trim();
    if (!owner || !repo || !token) throw new Error('Isi owner, repository engine, dan GitHub token terlebih dahulu.');
    return { owner, repo, branch, token };
  }

  function saveConfig() {
    const cfg = getConfig();
    const rememberToken = el.rememberTokenInput.checked;
    localStorage.setItem('azb2-config', JSON.stringify({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, rememberToken }));
    if (rememberToken) {
      localStorage.setItem('azb2-token', cfg.token);
      sessionStorage.removeItem('azb2-token');
    } else {
      sessionStorage.setItem('azb2-token', cfg.token);
      localStorage.removeItem('azb2-token');
    }
    refreshConnectionBadge();
  }

  function hasBasicConfig() {
    try { getConfig(); return true; } catch (_) { return false; }
  }

  function refreshConnectionBadge() {
    try {
      const cfg = getConfig();
      el.connectionBadge.textContent = `${cfg.owner}/${cfg.repo}`;
      el.connectionBadge.className = 'badge ok';
    } catch (_) {
      el.connectionBadge.textContent = 'Belum terhubung';
      el.connectionBadge.className = 'badge muted';
    }
    el.buildButton.disabled = busy || !selectedFile || !hasBasicConfig();
  }

  async function gh(path, options = {}) {
    const cfg = getConfig();
    const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
    const headers = new Headers(options.headers || {});
    headers.set('Accept', headers.get('Accept') || 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${cfg.token}`);
    headers.set('X-GitHub-Api-Version', API_VERSION);
    let body = options.body;
    if (body && !(body instanceof Blob) && !(body instanceof File) && typeof body !== 'string') {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }
    const res = await fetch(url, { ...options, body, headers, cache: options.cache || 'no-store' });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.message || JSON.stringify(j); } catch (_) { detail = await res.text(); }
      throw new Error(`GitHub ${res.status}: ${detail || res.statusText}`);
    }
    if (res.status === 204) return null;
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res;
  }

  function setBusy(value) {
    busy = value;
    el.buildButton.disabled = value || !selectedFile || !hasBasicConfig();
    el.settingsButton.disabled = value;
  }

  function setStatus(title, subtitle, badge = 'WORKING', progress = 8, cls = '') {
    el.statusCard.classList.remove('hidden');
    el.statusTitle.textContent = title;
    el.statusSubtitle.textContent = subtitle || '';
    el.statusBadge.textContent = badge;
    el.statusBadge.className = `badge ${cls}`.trim();
    el.progressBar.style.width = `${Math.max(3, Math.min(100, progress))}%`;
  }

  function log(text) {
    const now = new Date().toLocaleTimeString('id-ID', { hour12: false });
    el.logBox.style.display = 'block';
    el.logBox.textContent += `[${now}] ${text}\n`;
    el.logBox.scrollTop = el.logBox.scrollHeight;
  }

  function renderSteps(jobs) {
    if (!jobs?.length) return;
    const allSteps = jobs.flatMap(j => (j.steps || []).map(s => ({ ...s, job: j.name })));
    el.steps.innerHTML = allSteps.map(s => {
      const cls = s.conclusion === 'failure' ? 'failed' : s.status === 'completed' ? 'done' : s.status === 'in_progress' ? 'active' : '';
      return `<div class="step ${cls}"><span class="dot"></span><span>${escapeHtml(s.name)}</span></div>`;
    }).join('');
  }

  async function testConnection() {
    el.connectionResult.textContent = 'Mengecek…';
    try {
      const cfg = getConfig();
      const repo = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`);
      if (!repo.private) throw new Error('Repository engine harus Private.');
      await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/workflows/${WORKFLOW_FILE}`);
      el.connectionResult.textContent = `OK — ${repo.full_name} (Private), workflow ditemukan.`;
      saveConfig();
      refreshConnectionBadge();
    } catch (e) {
      el.connectionResult.textContent = e.message;
    }
  }

  function chooseFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      alert('File harus berupa project .zip');
      return;
    }
    if (file.size > MAX_ZIP_BYTES) {
      alert(`ZIP terlalu besar untuk mode web GitHub-only v2. Maksimum ${fmtBytes(MAX_ZIP_BYTES)}.`);
      return;
    }
    selectedFile = file;
    el.fileTitle.textContent = file.name;
    el.fileMeta.textContent = `${fmtBytes(file.size)} · siap diupload`;
    refreshConnectionBadge();
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Gagal membaca ZIP.'));
      reader.onload = () => {
        const value = String(reader.result || '');
        const comma = value.indexOf(',');
        if (comma < 0) return reject(new Error('Gagal mengubah ZIP ke Base64.'));
        resolve(value.slice(comma + 1));
      };
      reader.readAsDataURL(file);
    });
  }

  async function uploadProject(cfg, id, file) {
    const path = `jobs/${id}/project.zip`;
    log(`Membaca ZIP ${fmtBytes(file.size)}…`);
    const content = await fileToBase64(file);
    log('Mengirim ZIP ke repository engine private…');
    const result = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`, {
      method: 'PUT',
      body: {
        message: `builder: upload ${id}`,
        content,
        branch: cfg.branch
      }
    });
    return { path, sha: result?.content?.sha || '' };
  }

  async function dispatchBuild(cfg, id, inputPath, variant) {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      body: {
        ref: cfg.branch,
        inputs: { job_id: id, input_path: inputPath, variant }
      }
    });

    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(2500);
      const runs = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&branch=${encodeURIComponent(cfg.branch)}&per_page=30`);
      const run = (runs.workflow_runs || []).find(r => {
        const created = r.created_at || '';
        const title = r.display_title || r.name || '';
        return created >= startedAt && title.includes(id);
      });
      if (run) return run.id;
    }
    throw new Error('Workflow sudah dipicu tetapi run ID belum ditemukan. Cek tab Actions.');
  }

  async function waitForRun(cfg, runId) {
    for (;;) {
      const run = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/runs/${runId}`);
      const jobsData = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/runs/${runId}/jobs?per_page=100`);
      renderSteps(jobsData.jobs || []);
      if (run.status === 'queued') setStatus('Menunggu runner', 'GitHub Actions sedang antre…', 'QUEUED', 25);
      else if (run.status === 'in_progress') setStatus('Sedang membuild APK', 'Gradle berjalan di GitHub Actions…', 'BUILD', 60);
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') throw new Error(`GitHub Actions selesai dengan status ${run.conclusion || 'failure'}.`);
        return;
      }
      await sleep(3500);
    }
  }

  async function fetchRaw(cfg, path) {
    return gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`, {
      headers: { 'Accept': 'application/vnd.github.raw+json' }
    });
  }

  async function waitForStatus(cfg, id) {
    const path = `jobs/${id}/status.json`;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const res = await fetchRaw(cfg, path);
        const text = await res.text();
        return JSON.parse(text);
      } catch (e) {
        if (!String(e.message).includes('GitHub 404')) throw e;
      }
      await sleep(2500);
    }
    throw new Error('Workflow selesai tetapi status hasil belum muncul di repository engine.');
  }

  async function deleteFile(cfg, path) {
    let info;
    try {
      info = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`);
    } catch (e) {
      if (String(e.message).includes('GitHub 404')) return;
      throw e;
    }
    await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`, {
      method: 'DELETE',
      body: { message: `builder: cleanup ${currentJobId || ''}`, sha: info.sha, branch: cfg.branch }
    });
  }

  async function cleanupJob(cfg, status) {
    const paths = [];
    if (status?.files) for (const f of status.files) if (f.path) paths.push(f.path);
    if (status?.log_path) paths.push(status.log_path);
    paths.push(`jobs/${currentJobId}/status.json`);
    for (const path of paths) {
      try { await deleteFile(cfg, path); } catch (e) { log(`Cleanup ${path} gagal: ${e.message}`); }
    }
    log('File job pada branch engine sudah dibersihkan.');
  }

  async function downloadPath(cfg, file, status, autoCleanup) {
    log(`Mengunduh ${file.name}…`);
    const res = await fetchRaw(cfg, file.path);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name || 'app.apk';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (autoCleanup) await cleanupJob(cfg, status);
  }

  function showResults(cfg, status) {
    const files = status.files || [];
    el.resultArea.classList.remove('hidden');
    el.resultArea.innerHTML = '';
    files.forEach((file) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      row.innerHTML = `<span class="name">${escapeHtml(file.name)}</span>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button primary';
      btn.textContent = 'DOWNLOAD APK';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await downloadPath(cfg, file, status, files.length === 1); }
        catch (e) { alert(e.message); }
        finally { btn.disabled = false; }
      });
      row.appendChild(btn);
      el.resultArea.appendChild(row);
    });
  }

  async function loadFailureLog(cfg, status) {
    if (!status?.log_path) return;
    try {
      const res = await fetchRaw(cfg, status.log_path);
      const text = await res.text();
      el.logBox.style.display = 'block';
      el.logBox.textContent = text;
      el.logBox.scrollTop = el.logBox.scrollHeight;
    } catch (_) {}
  }

  async function build() {
    if (!selectedFile || busy) return;
    try {
      saveConfig();
      const cfg = getConfig();
      const variant = document.querySelector('input[name="variant"]:checked').value;
      const id = makeJobId();
      currentJobId = id;
      setBusy(true);
      el.logBox.textContent = '';
      el.steps.innerHTML = '';
      el.resultArea.innerHTML = '';
      el.resultArea.classList.add('hidden');

      setStatus('Mengupload project', `${selectedFile.name} · ${fmtBytes(selectedFile.size)}`, 'UPLOAD', 8);
      log(`Job ID: ${id}`);
      const uploaded = await uploadProject(cfg, id, selectedFile);
      log(`ZIP tersimpan di ${uploaded.path}`);

      setStatus('Upload selesai', 'Memulai GitHub Actions…', 'START', 18);
      const runId = await dispatchBuild(cfg, id, uploaded.path, variant);
      log(`Workflow run: ${runId}`);
      await waitForRun(cfg, runId);

      const status = await waitForStatus(cfg, id);
      if (status.state !== 'success') {
        await loadFailureLog(cfg, status);
        throw new Error(status.message || 'Build gagal.');
      }
      const files = status.files || [];
      if (!files.length) throw new Error('Build sukses tetapi tidak ada APK pada status hasil.');
      setStatus('APK siap', `${files.length} file APK tersedia.`, 'READY', 100, 'ok');
      log(`APK siap: ${files.map(x => x.name).join(', ')}`);
      showResults(cfg, status);
      if (files.length === 1) await downloadPath(cfg, files[0], status, true);
    } catch (e) {
      log(`ERROR: ${e.message}`);
      setStatus('Proses berhenti', e.message, 'ERROR', 100, 'bad');
      if (currentJobId) {
        try {
          const cfg = getConfig();
          const status = await waitForStatus(cfg, currentJobId);
          await loadFailureLog(cfg, status);
        } catch (_) {}
      }
    } finally {
      setBusy(false);
    }
  }

  el.settingsButton.addEventListener('click', () => el.setupCard.classList.toggle('hidden'));
  el.saveButton.addEventListener('click', () => {
    try { saveConfig(); el.connectionResult.textContent = 'Pengaturan tersimpan.'; el.setupCard.classList.add('hidden'); }
    catch (e) { el.connectionResult.textContent = e.message; }
  });
  el.testButton.addEventListener('click', testConnection);
  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => chooseFile(el.fileInput.files?.[0]));
  ['dragenter', 'dragover'].forEach(type => el.dropZone.addEventListener(type, (e) => { e.preventDefault(); el.dropZone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(type => el.dropZone.addEventListener(type, (e) => { e.preventDefault(); el.dropZone.classList.remove('drag'); }));
  el.dropZone.addEventListener('drop', (e) => chooseFile(e.dataTransfer?.files?.[0]));
  el.buildButton.addEventListener('click', build);
  [el.ownerInput, el.repoInput, el.branchInput, el.tokenInput].forEach(input => input.addEventListener('input', refreshConnectionBadge));

  loadConfig();
})();
