(() => {
  'use strict';

  const API_VERSION = '2026-03-10';
  const WORKFLOW_FILE = 'build-apk.yml';
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
  let currentReleaseId = null;
  let workflowStarted = false;

  const fmtBytes = (bytes) => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  };

  function loadConfig() {
    const saved = JSON.parse(localStorage.getItem('azb-config') || '{}');
    el.ownerInput.value = saved.owner || '';
    el.repoInput.value = saved.repo || '';
    el.branchInput.value = saved.branch || 'main';
    el.rememberTokenInput.checked = Boolean(saved.rememberToken);
    const token = saved.rememberToken ? (localStorage.getItem('azb-token') || '') : (sessionStorage.getItem('azb-token') || '');
    el.tokenInput.value = token;
    refreshConnectionBadge();
    if (!saved.owner || !saved.repo || !token) el.setupCard.classList.remove('hidden');
  }

  function getConfig() {
    const owner = el.ownerInput.value.trim();
    const repo = el.repoInput.value.trim();
    const branch = el.branchInput.value.trim() || 'main';
    const token = el.tokenInput.value.trim();
    if (!owner || !repo || !token) throw new Error('Isi owner, repository, dan GitHub token terlebih dahulu.');
    return { owner, repo, branch, token };
  }

  function saveConfig() {
    const cfg = getConfig();
    const rememberToken = el.rememberTokenInput.checked;
    localStorage.setItem('azb-config', JSON.stringify({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, rememberToken }));
    if (rememberToken) {
      localStorage.setItem('azb-token', cfg.token);
      sessionStorage.removeItem('azb-token');
    } else {
      sessionStorage.setItem('azb-token', cfg.token);
      localStorage.removeItem('azb-token');
    }
    refreshConnectionBadge();
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

  function hasBasicConfig() {
    try { getConfig(); return true; } catch (_) { return false; }
  }

  async function gh(pathOrUrl, options = {}) {
    const cfg = getConfig();
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
    const headers = new Headers(options.headers || {});
    headers.set('Accept', headers.get('Accept') || 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${cfg.token}`);
    headers.set('X-GitHub-Api-Version', API_VERSION);
    if (options.body && !(options.body instanceof Blob) && !(options.body instanceof File) && typeof options.body !== 'string') {
      headers.set('Content-Type', 'application/json');
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, { ...options, headers });
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

  const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const jobId = () => `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;

  async function testConnection() {
    el.connectionResult.textContent = 'Mengecek…';
    try {
      const cfg = getConfig();
      const repo = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`);
      await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/workflows/${WORKFLOW_FILE}`);
      el.connectionResult.textContent = `OK — ${repo.full_name}, workflow builder ditemukan.`;
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
    // GitHub release assets support very large files; keep a browser/device safety guard.
    if (file.size > 1.9 * 1024 * 1024 * 1024) {
      alert('ZIP terlalu besar. Maksimum builder v1 adalah sekitar 1.9 GiB.');
      return;
    }
    selectedFile = file;
    el.fileTitle.textContent = file.name;
    el.fileMeta.textContent = `${fmtBytes(file.size)} · siap diupload`;
    refreshConnectionBadge();
  }

  async function createDraftRelease(cfg, id) {
    return gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/releases`, {
      method: 'POST',
      body: {
        tag_name: `builder-upload-${id}`,
        target_commitish: cfg.branch,
        name: `Temporary build ${id}`,
        body: 'Temporary private draft used by Android ZIP Builder. Safe to delete.',
        draft: true,
        prerelease: true
      }
    });
  }

  async function uploadProject(release, file) {
    const uploadUrl = release.upload_url.replace('{?name,label}', '') + `?name=${encodeURIComponent('project.zip')}`;
    return gh(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'Accept': 'application/vnd.github+json' },
      body: file
    });
  }

  async function dispatchBuild(cfg, id, release, asset, variant) {
    const response = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      body: {
        ref: cfg.branch,
        inputs: {
          job_id: id,
          release_id: String(release.id),
          asset_id: String(asset.id),
          asset_name: selectedFile.name,
          variant
        }
      }
    });
    if (response?.workflow_run_id) return response.workflow_run_id;

    // Compatibility fallback for older API behavior that returned 204 without run ID.
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(2500);
      const runs = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=20`);
      const match = runs.workflow_runs?.find(r => (r.display_title || '').includes(id));
      if (match) return match.id;
    }
    throw new Error('Workflow berhasil dipicu, tetapi run ID tidak ditemukan.');
  }

  async function waitForRun(cfg, runId) {
    let lastStepSignature = '';
    for (;;) {
      const run = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/runs/${runId}`);
      const jobs = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/runs/${runId}/jobs?per_page=100`);
      renderSteps(jobs.jobs || []);

      const steps = (jobs.jobs || []).flatMap(j => j.steps || []);
      const done = steps.filter(s => s.status === 'completed').length;
      const active = steps.find(s => s.status === 'in_progress');
      const progress = steps.length ? Math.min(92, 20 + Math.round((done / steps.length) * 68)) : 20;
      const signature = `${done}/${steps.length}:${active?.name || ''}`;
      if (signature !== lastStepSignature) {
        lastStepSignature = signature;
        if (active) log(active.name);
      }

      if (run.status === 'queued') setStatus('Build masuk antrean', 'GitHub runner sedang disiapkan.', 'QUEUED', 18);
      else if (run.status !== 'completed') setStatus('Sedang membuild APK', active?.name || 'Gradle sedang berjalan…', 'BUILDING', progress);
      else {
        if (run.conclusion === 'success') {
          setStatus('Build berhasil', 'Menyiapkan APK untuk download…', 'SUCCESS', 96, 'ok');
          return run;
        }
        setStatus('Build gagal', `Conclusion: ${run.conclusion || 'failure'}`, 'FAILED', 100, 'bad');
        throw new Error(`Build gagal (${run.conclusion || 'unknown'}). Buka Actions run untuk log lengkap: ${run.html_url}`);
      }
      await sleep(4000);
    }
  }

  async function waitForApkAssets(cfg, releaseId) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const assets = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/releases/${releaseId}/assets?per_page=100`);
      const apks = assets.filter(a => a.name.toLowerCase().endsWith('.apk'));
      if (apks.length) return apks;
      await sleep(2500);
    }
    throw new Error('Workflow selesai, tetapi APK belum muncul di draft release.');
  }

  async function downloadAsset(cfg, asset, autoCleanup) {
    log(`Mengunduh ${asset.name}…`);
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/releases/assets/${asset.id}`, {
      headers: {
        'Accept': 'application/octet-stream',
        'Authorization': `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': API_VERSION
      },
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`Download APK gagal: GitHub ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = asset.name.replace(/^result-\d+-/, '') || 'app.apk';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    if (autoCleanup && currentReleaseId) {
      try {
        await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/releases/${currentReleaseId}`, { method: 'DELETE' });
        log('File sementara GitHub sudah dibersihkan.');
        currentReleaseId = null;
      } catch (e) {
        log(`APK sudah didownload, tetapi cleanup gagal: ${e.message}`);
      }
    }
  }


  async function tryLoadFailureLog(cfg, releaseId) {
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const assets = await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/releases/${releaseId}/assets?per_page=100`);
        const logAsset = assets.find(a => a.name === 'build-log.txt');
        if (logAsset) {
          const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/releases/assets/${logAsset.id}`, {
            headers: {
              'Accept': 'application/octet-stream',
              'Authorization': `Bearer ${cfg.token}`,
              'X-GitHub-Api-Version': API_VERSION
            },
            redirect: 'follow'
          });
          if (res.ok) {
            const text = await res.text();
            el.logBox.style.display = 'block';
            el.logBox.textContent = text;
            el.logBox.scrollTop = el.logBox.scrollHeight;
            return true;
          }
        }
      } catch (_) {}
      await sleep(2500);
    }
    return false;
  }

  function showResults(cfg, assets) {
    el.resultArea.classList.remove('hidden');
    el.resultArea.innerHTML = '';
    assets.forEach((asset) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      row.innerHTML = `<span class="name">${escapeHtml(asset.name)}</span>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button primary';
      btn.textContent = 'DOWNLOAD APK';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await downloadAsset(cfg, asset, assets.length === 1); }
        catch (e) { alert(e.message); }
        finally { btn.disabled = false; }
      });
      row.appendChild(btn);
      el.resultArea.appendChild(row);
    });
  }

  async function build() {
    if (!selectedFile || busy) return;
    let release = null;
    try {
      saveConfig();
      const cfg = getConfig();
      const variant = document.querySelector('input[name="variant"]:checked').value;
      const id = jobId();
      setBusy(true);
      workflowStarted = false;
      el.logBox.textContent = '';
      el.steps.innerHTML = '';
      el.resultArea.innerHTML = '';
      el.resultArea.classList.add('hidden');

      setStatus('Mengupload project', `${selectedFile.name} · ${fmtBytes(selectedFile.size)}`, 'UPLOAD', 8);
      log(`Job ID: ${id}`);
      release = await createDraftRelease(cfg, id);
      currentReleaseId = release.id;
      log(`Draft release dibuat: ${release.id}`);

      const asset = await uploadProject(release, selectedFile);
      setStatus('Upload selesai', 'Memulai GitHub Actions…', 'START', 14);
      log(`Upload selesai (${fmtBytes(asset.size)}).`);

      const runId = await dispatchBuild(cfg, id, release, asset, variant);
      workflowStarted = true;
      log(`Workflow run: ${runId}`);
      await waitForRun(cfg, runId);

      const apks = await waitForApkAssets(cfg, release.id);
      setStatus('APK siap', `${apks.length} file APK tersedia.`, 'READY', 100, 'ok');
      log(`APK siap: ${apks.map(x => x.name).join(', ')}`);
      showResults(cfg, apks);

      if (apks.length === 1) {
        // One-tap flow: start the direct APK download automatically.
        await downloadAsset(cfg, apks[0], true);
      }
    } catch (e) {
      log(`ERROR: ${e.message}`);
      setStatus('Proses berhenti', e.message, 'ERROR', 100, 'bad');
      // If dispatch never happened, clean the draft ourselves. If it did happen and failed,
      // the workflow cleanup job also attempts this; duplicate DELETE is harmless.
      if (release && currentReleaseId) {
        try {
          const cfg = getConfig();
          if (workflowStarted) {
            const gotLog = await tryLoadFailureLog(cfg, release.id);
            if (gotLog) log('Build log kegagalan dimuat dari GitHub.');
          }
          await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/releases/${release.id}`, { method: 'DELETE' });
          currentReleaseId = null;
          log('File sementara GitHub dibersihkan.');
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
