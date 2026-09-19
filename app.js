(() => {
  'use strict';

  const API_VERSION = '2026-03-10';
  const WORKFLOW_FILE = 'build-apk.yml';
  const MAX_ZIP_BYTES = 1.9 * 1024 * 1024 * 1024;
  const CONFIG_KEY = 'turbo-v4-github-config';
  const TOKEN_LOCAL_KEY = 'turbo-v4-github-token';
  const TOKEN_SESSION_KEY = 'turbo-v4-github-token-session';

  const $ = (id) => document.getElementById(id);
  const el = {
    settingsButton: $('settingsButton'),
    setupCard: $('setupCard'),
    ownerInput: $('ownerInput'),
    repoInput: $('repoInput'),
    branchInput: $('branchInput'),
    tokenInput: $('tokenInput'),
    rememberTokenInput: $('rememberTokenInput'),
    testButton: $('testButton'),
    saveButton: $('saveButton'),
    connectionResult: $('connectionResult'),
    connectionBadge: $('connectionBadge'),
    fileInput: $('fileInput'),
    dropZone: $('dropZone'),
    fileTitle: $('fileTitle'),
    fileMeta: $('fileMeta'),
    buildButton: $('buildButton'),
    statusCard: $('statusCard'),
    statusTitle: $('statusTitle'),
    statusSubtitle: $('statusSubtitle'),
    statusBadge: $('statusBadge'),
    progressBar: $('progressBar'),
    steps: $('steps'),
    logBox: $('logBox'),
    resultArea: $('resultArea')
  };

  let selectedFile = null;
  let busy = false;
  let currentReleaseId = null;
  let currentJobId = null;
  let currentRunId = null;
  let currentAssets = [];
  let currentLogAsset = null;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function fmtBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = Number(bytes) || 0;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[ch]));
  }

  function makeJobId() {
    const random = crypto.getRandomValues(new Uint32Array(2));
    const suffix = `${random[0].toString(36)}${random[1].toString(36)}`;
    return `job-${Date.now()}-${suffix}`;
  }

  function loadConfig() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    } catch (_) {}

    el.ownerInput.value = saved.owner || 'gehiuriko';
    el.repoInput.value = saved.repo || 'builder-engine-turbo';
    el.branchInput.value = saved.branch || 'main';
    el.rememberTokenInput.checked = Boolean(saved.rememberToken);

    const token = saved.rememberToken
      ? (localStorage.getItem(TOKEN_LOCAL_KEY) || '')
      : (sessionStorage.getItem(TOKEN_SESSION_KEY) || '');

    el.tokenInput.value = token;
    refreshConnectionBadge();

    if (!token) el.setupCard.classList.remove('hidden');
  }

  function getConfig() {
    const owner = el.ownerInput.value.trim();
    const repo = el.repoInput.value.trim();
    const branch = el.branchInput.value.trim() || 'main';
    const token = el.tokenInput.value.trim();

    if (!owner || !repo || !token) {
      throw new Error('Isi GitHub Owner, Repository Engine, Branch, dan Fine-grained PAT.');
    }

    return { owner, repo, branch, token };
  }

  function saveConfig() {
    const cfg = getConfig();
    const rememberToken = el.rememberTokenInput.checked;

    localStorage.setItem(CONFIG_KEY, JSON.stringify({
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch,
      rememberToken
    }));

    if (rememberToken) {
      localStorage.setItem(TOKEN_LOCAL_KEY, cfg.token);
      sessionStorage.removeItem(TOKEN_SESSION_KEY);
    } else {
      sessionStorage.setItem(TOKEN_SESSION_KEY, cfg.token);
      localStorage.removeItem(TOKEN_LOCAL_KEY);
    }

    refreshConnectionBadge();
  }

  function hasConfig() {
    try {
      getConfig();
      return true;
    } catch (_) {
      return false;
    }
  }

  function refreshConnectionBadge() {
    if (hasConfig()) {
      const cfg = getConfig();
      el.connectionBadge.textContent = `${cfg.owner}/${cfg.repo}`;
      el.connectionBadge.className = 'badge ok';
    } else {
      el.connectionBadge.textContent = 'Belum terhubung';
      el.connectionBadge.className = 'badge muted';
    }

    el.buildButton.disabled = busy || !selectedFile || !hasConfig();
  }

  async function githubFetch(urlOrPath, options = {}) {
    const cfg = getConfig();
    const url = /^https:\/\//i.test(urlOrPath)
      ? urlOrPath
      : `https://api.github.com${urlOrPath}`;

    const headers = new Headers(options.headers || {});
    if (!headers.has('Accept')) headers.set('Accept', 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${cfg.token}`);
    headers.set('X-GitHub-Api-Version', API_VERSION);

    let body = options.body;
    if (
      body &&
      !(body instanceof Blob) &&
      !(body instanceof File) &&
      !(body instanceof ArrayBuffer) &&
      typeof body !== 'string'
    ) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }

    const response = await fetch(url, {
      ...options,
      headers,
      body,
      cache: options.cache || 'no-store'
    });

    if (!response.ok) {
      let detail = '';
      try {
        const j = await response.json();
        detail = j.message || JSON.stringify(j);
      } catch (_) {
        try { detail = await response.text(); } catch (_) {}
      }
      throw new Error(`GitHub ${response.status}: ${detail || response.statusText}`);
    }

    if (response.status === 204) return null;

    const type = response.headers.get('content-type') || '';
    if (type.includes('json')) return response.json();
    return response;
  }

  function setBusy(value) {
    busy = value;
    el.settingsButton.disabled = value;
    el.buildButton.disabled = value || !selectedFile || !hasConfig();
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

    const all = jobs.flatMap(job =>
      (job.steps || []).map(step => ({ ...step, jobName: job.name }))
    );

    el.steps.innerHTML = all.map(step => {
      const cls =
        step.conclusion === 'failure' ? 'failed' :
        step.status === 'completed' ? 'done' :
        step.status === 'in_progress' ? 'active' : '';

      return `<div class="step ${cls}">
        <span class="dot"></span>
        <span>${escapeHtml(step.name)}</span>
      </div>`;
    }).join('');
  }

  async function testConnection() {
    el.connectionResult.textContent = 'Mengecek GitHub…';

    try {
      saveConfig();
      const cfg = getConfig();

      const repo = await githubFetch(
        `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`
      );

      await githubFetch(
        `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}` +
        `/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}`
      );

      el.connectionResult.textContent =
        `OK — ${repo.full_name}. Workflow ${WORKFLOW_FILE} ditemukan.`;
      el.connectionBadge.textContent = 'GitHub siap';
      el.connectionBadge.className = 'badge ok';
    } catch (error) {
      el.connectionResult.textContent = error.message;
      el.connectionBadge.textContent = 'Koneksi gagal';
      el.connectionBadge.className = 'badge bad';
    }
  }

  function chooseFile(file) {
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.zip')) {
      alert('File harus berupa project .zip');
      return;
    }

    if (file.size <= 0 || file.size > MAX_ZIP_BYTES) {
      alert('ZIP terlalu besar. Batas builder ini sekitar 1.9 GiB per file.');
      return;
    }

    selectedFile = file;
    el.fileTitle.textContent = file.name;
    el.fileMeta.textContent = `${fmtBytes(file.size)} · siap direct upload ke GitHub`;
    refreshConnectionBadge();
  }

  async function createDraftRelease(cfg, jobId) {
    return githubFetch(
      `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/releases`,
      {
        method: 'POST',
        body: {
          tag_name: `builder-${jobId}`,
          target_commitish: cfg.branch,
          name: `Temporary Android build ${jobId}`,
          body: 'Temporary draft release used by Android ZIP Builder Turbo V4.',
          draft: true,
          prerelease: true
        }
      }
    );
  }

  async function uploadSourceAsset(release, file, jobId) {
    const uploadBase = String(release.upload_url || '').replace(/\{\?name,label\}$/, '');
    if (!uploadBase) throw new Error('GitHub tidak mengembalikan upload_url.');

    const assetName = `${jobId}-source.zip`;
    const url = `${uploadBase}?name=${encodeURIComponent(assetName)}`;

    return githubFetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/zip'
      },
      body: file
    });
  }

  async function dispatchBuild(cfg, jobId, release, asset, variant) {
    const startedAt = Date.now();

    await githubFetch(
      `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}` +
      `/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/dispatches`,
      {
        method: 'POST',
        body: {
          ref: cfg.branch,
          inputs: {
            job_id: jobId,
            release_id: String(release.id),
            asset_id: String(asset.id),
            asset_name: selectedFile.name,
            variant
          }
        }
      }
    );

    for (let attempt = 0; attempt < 35; attempt++) {
      await sleep(attempt === 0 ? 1200 : 1800);

      const runs = await githubFetch(
        `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}` +
        `/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/runs` +
        `?event=workflow_dispatch&branch=${encodeURIComponent(cfg.branch)}&per_page=30`
      );

      const match = (runs.workflow_runs || []).find(run => {
        const title = String(run.display_title || '');
        const created = Date.parse(run.created_at || '') || 0;
        return title.includes(jobId) && created >= startedAt - 60_000;
      });

      if (match) return match.id;
    }

    throw new Error('Workflow sudah dipicu tetapi run ID belum ditemukan.');
  }

  async function waitForRun(cfg, runId) {
    let lastSignature = '';

    for (;;) {
      const [run, jobs] = await Promise.all([
        githubFetch(
          `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}` +
          `/actions/runs/${runId}`
        ),
        githubFetch(
          `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}` +
          `/actions/runs/${runId}/jobs?per_page=100`
        )
      ]);

      renderSteps(jobs.jobs || []);

      const steps = (jobs.jobs || []).flatMap(job => job.steps || []);
      const done = steps.filter(step => step.status === 'completed').length;
      const active = steps.find(step => step.status === 'in_progress');
      const progress = steps.length
        ? Math.min(94, 22 + Math.round((done / steps.length) * 68))
        : 20;

      const signature = `${run.status}:${done}/${steps.length}:${active?.name || ''}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        if (active) log(active.name);
      }

      if (run.status === 'queued') {
        setStatus('Build masuk antrean', 'Menunggu GitHub runner…', 'QUEUED', 18);
      } else if (run.status !== 'completed') {
        setStatus(
          'Sedang membuild APK',
          active?.name || 'GitHub Actions sedang berjalan…',
          'BUILDING',
          progress
        );
      } else {
        if (run.conclusion === 'success') {
          setStatus('Build berhasil', 'Mengambil hasil APK…', 'SUCCESS', 96, 'ok');
          return run;
        }

        setStatus(
          'Build gagal',
          `Conclusion: ${run.conclusion || 'failure'}`,
          'FAILED',
          100,
          'bad'
        );
        return run;
      }

      await sleep(3500);
    }
  }

  async function listReleaseAssets(cfg, releaseId) {
    return githubFetch(
      `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}` +
      `/releases/${releaseId}/assets?per_page=100`
    );
  }

  async function waitForOutputAssets(cfg, releaseId, jobId, expectSuccess) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const assets = await listReleaseAssets(cfg, releaseId);

      const apks = assets.filter(asset =>
        asset.name.startsWith(`${jobId}-result-`) &&
        asset.name.toLowerCase().endsWith('.apk')
      );

      const logAsset = assets.find(asset => asset.name === `${jobId}-build.log`) || null;
      const statusAsset = assets.find(asset => asset.name === `${jobId}-status.json`) || null;

      if (expectSuccess && apks.length) {
        return { apks, logAsset, statusAsset };
      }

      if (!expectSuccess && (logAsset || statusAsset)) {
        return { apks, logAsset, statusAsset };
      }

      await sleep(2000);
    }

    return { apks: [], logAsset: null, statusAsset: null };
  }

  async function fetchAssetBlob(cfg, asset) {
    const res = await githubFetch(
      `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}` +
      `/releases/assets/${asset.id}`,
      {
        headers: { 'Accept': 'application/octet-stream' },
        redirect: 'follow'
      }
    );

    if (res instanceof Response) return res.blob();

    throw new Error(`Asset ${asset.name} tidak mengembalikan binary.`);
  }

  async function fetchAssetText(cfg, asset) {
    const blob = await fetchAssetBlob(cfg, asset);
    return blob.text();
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  }

  async function downloadAsset(cfg, asset, button) {
    const old = button?.textContent;

    try {
      if (button) {
        button.disabled = true;
        button.textContent = 'DOWNLOADING…';
      }

      log(`Mengunduh ${asset.name} dari GitHub…`);
      const blob = await fetchAssetBlob(cfg, asset);
      const cleanName = asset.name.replace(
        new RegExp(`^${currentJobId}-result-\\d+-`),
        ''
      ) || 'app.apk';

      triggerDownload(blob, cleanName);
      log(`Download dimulai: ${cleanName} (${fmtBytes(blob.size)}).`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = old || 'DOWNLOAD APK';
      }
    }
  }

  async function deleteRelease(cfg) {
    if (!currentReleaseId) return;

    await githubFetch(
      `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}` +
      `/releases/${currentReleaseId}`,
      { method: 'DELETE' }
    );

    log('Temporary draft release sudah dihapus.');
    currentReleaseId = null;
  }

  function showResults(cfg, apks, logAsset) {
    el.resultArea.classList.remove('hidden');
    el.resultArea.innerHTML = '';

    apks.forEach(asset => {
      const row = document.createElement('div');
      row.className = 'result-row';

      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = `${asset.name} · ${fmtBytes(asset.size)}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button primary';
      btn.textContent = 'DOWNLOAD APK';
      btn.addEventListener('click', async () => {
        try {
          await downloadAsset(cfg, asset, btn);
        } catch (error) {
          alert(error.message);
          log(`ERROR download: ${error.message}`);
        }
      });

      row.append(label, btn);
      el.resultArea.appendChild(row);
    });

    const actions = document.createElement('div');
    actions.className = 'result-actions';

    if (logAsset) {
      const logBtn = document.createElement('button');
      logBtn.type = 'button';
      logBtn.className = 'button secondary';
      logBtn.textContent = 'BUKA BUILD LOG';
      logBtn.addEventListener('click', async () => {
        try {
          logBtn.disabled = true;
          const text = await fetchAssetText(cfg, logAsset);
          el.logBox.style.display = 'block';
          el.logBox.textContent = text;
          el.logBox.scrollTop = el.logBox.scrollHeight;
        } catch (error) {
          alert(error.message);
        } finally {
          logBtn.disabled = false;
        }
      });
      actions.appendChild(logBtn);
    }

    const cleanBtn = document.createElement('button');
    cleanBtn.type = 'button';
    cleanBtn.className = 'button secondary';
    cleanBtn.textContent = 'BERSIHKAN FILE SEMENTARA';
    cleanBtn.addEventListener('click', async () => {
      try {
        cleanBtn.disabled = true;
        await deleteRelease(cfg);
        cleanBtn.textContent = 'SUDAH DIBERSIHKAN';
      } catch (error) {
        cleanBtn.disabled = false;
        alert(error.message);
      }
    });
    actions.appendChild(cleanBtn);

    el.resultArea.appendChild(actions);
  }

  async function loadFailureLog(cfg, releaseId, jobId) {
    const output = await waitForOutputAssets(cfg, releaseId, jobId, false);

    if (output.logAsset) {
      try {
        const text = await fetchAssetText(cfg, output.logAsset);
        el.logBox.style.display = 'block';
        el.logBox.textContent = text;
        el.logBox.scrollTop = el.logBox.scrollHeight;
        currentLogAsset = output.logAsset;
        log('Build log kegagalan berhasil dimuat.');
      } catch (error) {
        log(`Build log ada, tetapi gagal dimuat: ${error.message}`);
      }
    }

    return output;
  }

  async function cleanupOnEarlyFailure(cfg, release) {
    if (!release?.id) return;
    try {
      await githubFetch(
        `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}` +
        `/releases/${release.id}`,
        { method: 'DELETE' }
      );
      if (currentReleaseId === release.id) currentReleaseId = null;
      log('Temporary release dibersihkan karena build belum sempat berjalan.');
    } catch (_) {}
  }

  async function build() {
    if (!selectedFile || busy) return;

    let cfg;
    let release = null;
    let workflowDispatched = false;

    try {
      saveConfig();
      cfg = getConfig();

      const variant =
        document.querySelector('input[name="variant"]:checked')?.value || 'debug';

      currentJobId = makeJobId();
      currentReleaseId = null;
      currentRunId = null;
      currentAssets = [];
      currentLogAsset = null;

      setBusy(true);
      el.steps.innerHTML = '';
      el.logBox.textContent = '';
      el.logBox.style.display = 'block';
      el.resultArea.innerHTML = '';
      el.resultArea.classList.add('hidden');

      setStatus(
        'Menyiapkan upload',
        `${selectedFile.name} · ${fmtBytes(selectedFile.size)}`,
        'PREPARE',
        5
      );
      log(`Job ID: ${currentJobId}`);

      release = await createDraftRelease(cfg, currentJobId);
      currentReleaseId = release.id;
      log(`Temporary draft release: ${release.id}`);

      setStatus(
        'Mengupload project',
        'Binary ZIP langsung ke GitHub Release…',
        'UPLOAD',
        10
      );

      const sourceAsset = await uploadSourceAsset(release, selectedFile, currentJobId);
      log(`Upload selesai: ${fmtBytes(sourceAsset.size)}.`);

      setStatus(
        'Memulai runner',
        'Mengirim workflow_dispatch…',
        'START',
        16
      );

      currentRunId = await dispatchBuild(
        cfg,
        currentJobId,
        release,
        sourceAsset,
        variant
      );
      workflowDispatched = true;

      log(`GitHub Actions run: ${currentRunId}`);

      const run = await waitForRun(cfg, currentRunId);

      if (run.conclusion !== 'success') {
        const output = await loadFailureLog(cfg, release.id, currentJobId);
        showResults(cfg, [], output.logAsset);
        throw new Error(
          `Build gagal (${run.conclusion || 'unknown'}). Build log sudah dicoba dimuat.`
        );
      }

      const output = await waitForOutputAssets(
        cfg,
        release.id,
        currentJobId,
        true
      );

      if (!output.apks.length) {
        throw new Error(
          'Workflow sukses tetapi APK belum ditemukan di temporary release.'
        );
      }

      currentAssets = output.apks;
      currentLogAsset = output.logAsset;

      setStatus(
        'APK siap',
        `${output.apks.length} APK tersedia untuk download.`,
        'READY',
        100,
        'ok'
      );

      log(`APK siap: ${output.apks.map(x => x.name).join(', ')}`);
      showResults(cfg, output.apks, output.logAsset);

    } catch (error) {
      log(`ERROR: ${error.message}`);

      if (!el.statusBadge.classList.contains('bad')) {
        setStatus('Proses berhenti', error.message, 'ERROR', 100, 'bad');
      }

      if (cfg && release && !workflowDispatched) {
        await cleanupOnEarlyFailure(cfg, release);
      }
    } finally {
      setBusy(false);
    }
  }

  el.settingsButton.addEventListener('click', () => {
    el.setupCard.classList.toggle('hidden');
  });

  el.saveButton.addEventListener('click', () => {
    try {
      saveConfig();
      el.connectionResult.textContent = 'Pengaturan tersimpan.';
      el.setupCard.classList.add('hidden');
    } catch (error) {
      el.connectionResult.textContent = error.message;
    }
  });

  el.testButton.addEventListener('click', testConnection);

  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => chooseFile(el.fileInput.files?.[0]));

  ['dragenter', 'dragover'].forEach(type => {
    el.dropZone.addEventListener(type, event => {
      event.preventDefault();
      el.dropZone.classList.add('drag');
    });
  });

  ['dragleave', 'drop'].forEach(type => {
    el.dropZone.addEventListener(type, event => {
      event.preventDefault();
      el.dropZone.classList.remove('drag');
    });
  });

  el.dropZone.addEventListener('drop', event => {
    chooseFile(event.dataTransfer?.files?.[0]);
  });

  el.buildButton.addEventListener('click', build);

  [
    el.ownerInput,
    el.repoInput,
    el.branchInput,
    el.tokenInput
  ].forEach(input => input.addEventListener('input', refreshConnectionBadge));

  loadConfig();
})();