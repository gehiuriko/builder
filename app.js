(() => {
  'use strict';

  const API_VERSION = '2026-03-10';
  const WORKFLOW_FILE = 'build-apk.yml';
  const MAX_ZIP_BYTES = 256 * 1024 * 1024;
  const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
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
  const downloadCache = new Map(); // successful chunks kept in RAM for resume

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

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Gagal membaca bagian ZIP.'));
      reader.onload = () => {
        const value = String(reader.result || '');
        const comma = value.indexOf(',');
        if (comma < 0) return reject(new Error('Gagal mengubah bagian ZIP ke Base64.'));
        resolve(value.slice(comma + 1));
      };
      reader.readAsDataURL(blob);
    });
  }

  function textToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const stride = 0x8000;
    for (let i = 0; i < bytes.length; i += stride) {
      binary += String.fromCharCode(...bytes.subarray(i, i + stride));
    }
    return btoa(binary);
  }

  async function uploadProject(cfg, id, file) {
    const base = `jobs/${id}/input`;
    const uploadedPaths = [];
    const parts = [];
    const totalParts = Math.ceil(file.size / UPLOAD_CHUNK_BYTES);
    log(`Membaca ZIP ${fmtBytes(file.size)} dalam ${totalParts} bagian…`);

    try {
      for (let i = 0; i < totalParts; i++) {
        const start = i * UPLOAD_CHUNK_BYTES;
        const end = Math.min(file.size, start + UPLOAD_CHUNK_BYTES);
        const slice = file.slice(start, end);
        const partName = `part-${String(i).padStart(4, '0')}.bin`;
        const path = `${base}/${partName}`;
        const content = await blobToBase64(slice);
        log(`Upload bagian ${i + 1}/${totalParts} (${fmtBytes(slice.size)})…`);
        await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`, {
          method: 'PUT',
          body: {
            message: `builder: upload ${id} part ${i + 1}/${totalParts}`,
            content,
            branch: cfg.branch
          }
        });
        uploadedPaths.push(path);
        parts.push({ path, size: slice.size });
        await sleep(250);
      }

      const manifestPath = `${base}/manifest.json`;
      const manifest = {
        version: 2,
        job_id: id,
        file_name: file.name,
        total_size: file.size,
        chunk_size: UPLOAD_CHUNK_BYTES,
        parts
      };
      await gh(`/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${manifestPath}`, {
        method: 'PUT',
        body: {
          message: `builder: upload manifest ${id}`,
          content: textToBase64(JSON.stringify(manifest, null, 2)),
          branch: cfg.branch
        }
      });
      uploadedPaths.push(manifestPath);
      return { path: manifestPath, parts: totalParts };
    } catch (e) {
      log(`Upload terhenti: ${e.message}. Membersihkan bagian yang sudah terkirim…`);
      for (const path of uploadedPaths.reverse()) {
        try { await deleteFile(cfg, path); } catch (_) {}
      }
      throw e;
    }
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
    const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.raw+json',
        'Authorization': `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': API_VERSION
      },
      cache: 'no-store'
    });
    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.clone().json();
        detail = data.message || JSON.stringify(data);
      } catch (_) {
        try { detail = await res.text(); } catch (_) {}
      }
      throw new Error(`GitHub ${res.status}: ${detail || res.statusText}`);
    }
    return res;
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
    if (status?.files) {
      for (const f of status.files) {
        if (f.path) paths.push(f.path);
        if (Array.isArray(f.parts)) {
          for (const part of f.parts) if (part?.path) paths.push(part.path);
        }
      }
    }
    if (status?.log_path) paths.push(status.log_path);
    paths.push(`jobs/${currentJobId}/status.json`);
    for (const path of paths) {
      try { await deleteFile(cfg, path); } catch (e) { log(`Cleanup ${path} gagal: ${e.message}`); }
    }
    log('File job pada branch engine sudah dibersihkan.');
  }

  function triggerBlobDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'app.apk';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function base64ToBlob(base64, type = 'application/octet-stream') {
    const clean = String(base64 || '').replace(/\s+/g, '');
    const chunks = [];
    const step = 4 * 1024 * 1024; // base64 chars; must stay divisible by 4
    for (let i = 0; i < clean.length; i += step) {
      const binary = atob(clean.slice(i, i + step));
      const bytes = new Uint8Array(binary.length);
      for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
      chunks.push(bytes);
    }
    return new Blob(chunks, { type });
  }

  function isRetryableDownloadError(error) {
    const msg = String(error?.message || error || '');
    if (/GitHub (401|403|404):/i.test(msg)) return false;
    return /Failed to fetch|NetworkError|Load failed|timeout|GitHub (408|409|425|429|500|502|503|504):/i.test(msg);
  }

  async function fetchBlobByPath(cfg, path, mime = 'application/octet-stream', attempts = 6) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        const info = await gh(
          `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(cfg.branch)}`,
          { headers: { 'Accept': 'application/vnd.github.object+json' } }
        );
        if (!info?.sha) throw new Error(`SHA Git tidak ditemukan untuk ${path}`);

        const data = await gh(
          `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/git/blobs/${encodeURIComponent(info.sha)}`,
          { headers: { 'Accept': 'application/vnd.github+json' } }
        );
        if (!data?.content || data.encoding !== 'base64') {
          throw new Error(`Git blob ${path} tidak mengembalikan Base64.`);
        }
        return base64ToBlob(data.content, mime);
      } catch (e) {
        lastError = e;
        if (!isRetryableDownloadError(e) || attempt >= attempts) break;

        const delay = Math.min(15000, 1200 * (2 ** (attempt - 1)));
        log(`Koneksi putus saat mengambil bagian. Retry ${attempt}/${attempts - 1} dalam ${(delay / 1000).toFixed(1)} dtk…`);
        await sleep(delay);
      }
    }

    throw new Error(
      `Gagal mengambil data dari GitHub setelah ${attempts} percobaan: ${lastError?.message || lastError}`
    );
  }

  async function downloadPath(cfg, file, status, autoCleanup) {
    const expectedSize = Number(file.size || 0);
    const mime = 'application/vnd.android.package-archive';

    if (Array.isArray(file.parts) && file.parts.length) {
      const cacheKey = `${status?.job_id || currentJobId || 'job'}::${file.name}`;
      let cached = downloadCache.get(cacheKey);
      if (!cached) {
        cached = new Map();
        downloadCache.set(cacheKey, cached);
      }

      log(`Mengunduh ${file.name} dalam ${file.parts.length} bagian via Git Blob API…`);
      if (cached.size) log(`Melanjutkan download: ${cached.size}/${file.parts.length} bagian sudah tersimpan di memori.`);

      const blobs = [];
      let received = 0;

      for (let i = 0; i < file.parts.length; i++) {
        const part = file.parts[i];
        let blob = cached.get(i);

        if (!blob) {
          setStatus(
            'Mengunduh APK',
            `${file.name} · bagian ${i + 1}/${file.parts.length}`,
            'DOWNLOAD',
            Math.max(5, Math.round((i / file.parts.length) * 100)),
            ''
          );

          try {
            blob = await fetchBlobByPath(cfg, part.path);
          } catch (e) {
            throw new Error(`Bagian ${i + 1}/${file.parts.length} gagal. ${e.message}`);
          }

          const partSize = Number(part.size || 0);
          if (partSize && blob.size !== partSize) {
            throw new Error(`Ukuran bagian ${i + 1} tidak cocok: ${blob.size} != ${partSize}`);
          }

          cached.set(i, blob);
          log(`Bagian ${i + 1}/${file.parts.length} selesai (${fmtBytes(blob.size)}).`);
        } else {
          log(`Bagian ${i + 1}/${file.parts.length} sudah tersimpan, dilewati.`);
        }

        blobs.push(blob);
        received += blob.size;

        const pct = expectedSize
          ? Math.round((received / expectedSize) * 100)
          : Math.round(((i + 1) / file.parts.length) * 100);

        setStatus(
          'Mengunduh APK',
          `${file.name} · ${fmtBytes(received)}${expectedSize ? ` / ${fmtBytes(expectedSize)}` : ''}`,
          'DOWNLOAD',
          Math.max(5, Math.min(100, pct)),
          ''
        );
        await sleep(80);
      }

      const apkBlob = new Blob(blobs, { type: mime });
      if (expectedSize && apkBlob.size !== expectedSize) {
        throw new Error(`Ukuran APK hasil gabung tidak cocok: ${apkBlob.size} != ${expectedSize}`);
      }

      triggerBlobDownload(apkBlob, file.name);
      downloadCache.delete(cacheKey);
      log(`APK ${file.name} selesai digabung: ${fmtBytes(apkBlob.size)}.`);
    } else {
      log(`Mengunduh ${file.name} via Git Blob API…`);
      const blob = await fetchBlobByPath(cfg, file.path, mime);
      if (expectedSize && blob.size !== expectedSize) {
        throw new Error(`Ukuran APK tidak cocok: ${blob.size} != ${expectedSize}`);
      }
      triggerBlobDownload(blob, file.name);
      log(`APK ${file.name} siap disimpan (${fmtBytes(blob.size)}).`);
    }

    if (autoCleanup) await cleanupJob(cfg, status);
  }

  function showResults(cfg, status) {
    const files = status.files || [];
    const downloaded = new Set();
    el.resultArea.classList.remove('hidden');
    el.resultArea.innerHTML = '';
    files.forEach((file, index) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      const detail = `${file.name}${file.size ? ` · ${fmtBytes(Number(file.size))}` : ''}${Array.isArray(file.parts) && file.parts.length ? ` · ${file.parts.length} bagian` : ''}`;
      row.innerHTML = `<span class="name">${escapeHtml(detail)}</span>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button primary';
      btn.textContent = 'DOWNLOAD APK';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await downloadPath(cfg, file, status, false);
          downloaded.add(index);
          btn.textContent = 'SUDAH DIDOWNLOAD';
          if (downloaded.size === files.length) {
            await cleanupJob(cfg, status);
            log('Semua APK sudah didownload; job dibersihkan otomatis.');
          }
        } catch (e) {
          alert(e.message);
          btn.disabled = false;
        }
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
      setStatus('APK siap', `${files.length} file APK tersedia. Tekan DOWNLOAD APK.`, 'READY', 100, 'ok');
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
