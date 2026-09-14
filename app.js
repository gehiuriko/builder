(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = {
    settingsButton:$('settingsButton'),setupCard:$('setupCard'),workerInput:$('workerInput'),keyInput:$('keyInput'),rememberKeyInput:$('rememberKeyInput'),testButton:$('testButton'),saveButton:$('saveButton'),connectionResult:$('connectionResult'),connectionBadge:$('connectionBadge'),
    fileInput:$('fileInput'),dropZone:$('dropZone'),fileTitle:$('fileTitle'),fileMeta:$('fileMeta'),buildButton:$('buildButton'),statusCard:$('statusCard'),statusTitle:$('statusTitle'),statusSubtitle:$('statusSubtitle'),statusBadge:$('statusBadge'),progressBar:$('progressBar'),speedLine:$('speedLine'),steps:$('steps'),logBox:$('logBox'),resultArea:$('resultArea')
  };
  let selectedFile=null,busy=false,currentJobId=null,pollTimer=null;
  const CFG_KEY='azb3-config', KEY_KEY='azb3-builder-key';
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const fmtBytes=b=>{const u=['B','KB','MB','GB'];let n=Number(b)||0,i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return `${n.toFixed(i?1:0)} ${u[i]}`};
  const fmtSpeed=bps=>bps>0?`${fmtBytes(bps)}/s`:'';
  const escapeHtml=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function log(text){const t=new Date().toLocaleTimeString('id-ID',{hour12:false});el.logBox.textContent+=`[${t}] ${text}\n`;el.logBox.scrollTop=el.logBox.scrollHeight}
  function setStatus(title,subtitle,badge='WORKING',progress=8,cls=''){el.statusCard.classList.remove('hidden');el.statusTitle.textContent=title;el.statusSubtitle.textContent=subtitle||'';el.statusBadge.textContent=badge;el.statusBadge.className=`badge ${cls}`.trim();el.progressBar.style.width=`${Math.max(3,Math.min(100,progress))}%`}
  function setSteps(items){el.steps.innerHTML=items.map(x=>`<div class="step ${x.state||''}"><span class="dot"></span><span>${escapeHtml(x.text)}</span></div>`).join('')}
  function getConfig(){const worker=el.workerInput.value.trim().replace(/\/+$/,'');const key=el.keyInput.value.trim();if(!worker||!/^https:\/\//i.test(worker))throw new Error('Isi URL Cloudflare Worker yang valid.');if(!key)throw new Error('Isi Builder Key.');return {worker,key}}
  function hasConfig(){try{getConfig();return true}catch{return false}}
  function loadConfig(){let saved={};try{saved=JSON.parse(localStorage.getItem(CFG_KEY)||'{}')}catch{}el.workerInput.value=saved.worker||'';el.rememberKeyInput.checked=Boolean(saved.rememberKey);el.keyInput.value=saved.rememberKey?(localStorage.getItem(KEY_KEY)||''):(sessionStorage.getItem(KEY_KEY)||'');refresh();if(!hasConfig())el.setupCard.classList.remove('hidden')}
  function saveConfig(){const c=getConfig();const rememberKey=el.rememberKeyInput.checked;localStorage.setItem(CFG_KEY,JSON.stringify({worker:c.worker,rememberKey}));if(rememberKey){localStorage.setItem(KEY_KEY,c.key);sessionStorage.removeItem(KEY_KEY)}else{sessionStorage.setItem(KEY_KEY,c.key);localStorage.removeItem(KEY_KEY)}refresh()}
  function refresh(){el.connectionBadge.textContent=hasConfig()?'Turbo API siap':'Belum terhubung';el.connectionBadge.className=hasConfig()?'badge ok':'badge muted';el.buildButton.disabled=busy||!selectedFile||!hasConfig()}
  function setBusy(v){busy=v;el.settingsButton.disabled=v;refresh()}

  async function api(path,opts={}){const c=getConfig();const headers=new Headers(opts.headers||{});headers.set('X-Builder-Key',c.key);if(opts.body&&typeof opts.body!=='string'){headers.set('Content-Type','application/json');opts={...opts,body:JSON.stringify(opts.body)}}const res=await fetch(`${c.worker}${path}`,{...opts,headers,cache:'no-store'});let data=null;const text=await res.text();try{data=text?JSON.parse(text):null}catch{data={message:text}}if(!res.ok)throw new Error(data?.error||data?.message||`HTTP ${res.status}`);return data}

  async function testConnection(){el.connectionResult.textContent='Mengecek…';try{saveConfig();const data=await api('/api/health');el.connectionResult.textContent=`OK — ${data.engine||'Turbo API'} · ${data.version||''}`;refresh()}catch(e){el.connectionResult.textContent=e.message}}
  function chooseFile(file){if(!file)return;if(!file.name.toLowerCase().endsWith('.zip'))return alert('File harus project .zip');selectedFile=file;el.fileTitle.textContent=file.name;el.fileMeta.textContent=`${fmtBytes(file.size)} · siap direct upload`;refresh()}

  function xhrPut(url,blob,headers={},onProgress){return new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('PUT',url,true);for(const [k,v] of Object.entries(headers))x.setRequestHeader(k,v);x.upload.onprogress=e=>{if(e.lengthComputable&&onProgress)onProgress(e.loaded,e.total)};x.onerror=()=>reject(new Error('Koneksi upload terputus.'));x.onabort=()=>reject(new Error('Upload dibatalkan.'));x.onload=()=>{if(x.status>=200&&x.status<300)resolve({etag:x.getResponseHeader('ETag')||'',status:x.status});else reject(new Error(`B2 upload HTTP ${x.status}`))};x.send(blob)})}

  async function uploadWithRetry(fn,max=4){let last;for(let i=1;i<=max;i++){try{return await fn(i)}catch(e){last=e;if(i===max)break;log(`Upload gagal, retry ${i}/${max-1}…`);await sleep(Math.min(5000,700*2**(i-1)))}}throw last}

  async function uploadSingle(job,file){const start=performance.now();await uploadWithRetry(()=>xhrPut(job.uploadUrl,file,job.uploadHeaders||{'Content-Type':'application/zip'},(loaded,total)=>{const sec=Math.max(.2,(performance.now()-start)/1000);setStatus('Mengupload project',`${fmtBytes(loaded)} / ${fmtBytes(total)}`,'UPLOAD',Math.round(loaded/total*45));el.speedLine.textContent=`${fmtSpeed(loaded/sec)} · direct ke Backblaze B2`}));log('Direct upload selesai.')}

  async function uploadMultipart(job,file){const partSize=job.partSize, total=Math.ceil(file.size/partSize), parts=new Array(total);let doneBytes=0;const started=performance.now();const progress=new Array(total).fill(0);let next=0;
    const update=()=>{const loaded=progress.reduce((a,b)=>a+b,0);const sec=Math.max(.2,(performance.now()-started)/1000);setStatus('Upload paralel',`${fmtBytes(loaded)} / ${fmtBytes(file.size)} · ${total} bagian`,'UPLOAD',Math.round(loaded/file.size*45));el.speedLine.textContent=`${fmtSpeed(loaded/sec)} · ${job.concurrency||4} jalur paralel`};
    async function worker(){for(;;){const i=next++;if(i>=total)return;const partNumber=i+1,start=i*partSize,end=Math.min(file.size,start+partSize),slice=file.slice(start,end);const signed=await api(`/api/jobs/${encodeURIComponent(job.jobId)}/part-url`,{method:'POST',body:{uploadId:job.uploadId,partNumber}});const result=await uploadWithRetry(()=>xhrPut(signed.url,slice,{},loaded=>{progress[i]=loaded;update()}));progress[i]=slice.size;doneBytes+=slice.size;parts[i]={partNumber,etag:result.etag};log(`Bagian ${partNumber}/${total} selesai (${fmtBytes(slice.size)}).`);update()}}
    const count=Math.min(job.concurrency||4,total);await Promise.all(Array.from({length:count},()=>worker()));
    await api(`/api/jobs/${encodeURIComponent(job.jobId)}/complete-upload`,{method:'POST',body:{uploadId:job.uploadId,parts}});log(`Multipart upload selesai: ${fmtBytes(doneBytes)}.`)
  }

  function renderResults(status){el.resultArea.classList.remove('hidden');el.resultArea.innerHTML='';const files=status.files||[];for(const f of files){const row=document.createElement('div');row.className='result-row';const name=document.createElement('span');name.className='name';name.textContent=`${f.name} · ${fmtBytes(f.size)}`;const btn=document.createElement('button');btn.className='button primary';btn.textContent='DOWNLOAD APK';btn.onclick=async()=>{btn.disabled=true;try{const d=await api(`/api/jobs/${encodeURIComponent(currentJobId)}/download`,{method:'POST',body:{kind:'apk',name:f.name}});log(`Membuka direct download ${f.name}…`);window.location.href=d.url;setTimeout(()=>btn.disabled=false,1500)}catch(e){btn.disabled=false;alert(e.message)}};row.append(name,btn);el.resultArea.appendChild(row)}
    if(status.log_key){const row=document.createElement('div');row.className='result-row';const name=document.createElement('span');name.className='name';name.textContent='build.log';const btn=document.createElement('button');btn.className='button secondary';btn.textContent='DOWNLOAD LOG';btn.onclick=async()=>{btn.disabled=true;try{const d=await api(`/api/jobs/${encodeURIComponent(currentJobId)}/download`,{method:'POST',body:{kind:'log'}});window.location.href=d.url;setTimeout(()=>btn.disabled=false,1500)}catch(e){btn.disabled=false;alert(e.message)}};row.append(name,btn);el.resultArea.appendChild(row)}
  }

  function stageProgress(state){return ({created:3,uploaded:45,dispatching:48,queued:50,preparing:56,detecting:62,building:76,publishing:92,success:100,failure:100})[state]||55}
  async function pollJob(){for(;;){const s=await api(`/api/jobs/${encodeURIComponent(currentJobId)}`);const state=s.state||'queued';const bad=state==='failure';const ok=state==='success';setStatus(ok?'APK siap':bad?'Build gagal':s.title||'GitHub Runner',s.message||state,state.toUpperCase(),stageProgress(state),ok?'ok':bad?'bad':'');setSteps([
      {text:'Upload project ke B2',state:['created'].includes(state)?'active':'done'},
      {text:'GitHub Runner',state:['uploaded','dispatching','queued'].includes(state)?'active':(['preparing','detecting','building','publishing','success'].includes(state)?'done':bad?'failed':'')},
      {text:'Gradle build',state:['preparing','detecting'].includes(state)?'active':(['building'].includes(state)?'active':(['publishing','success'].includes(state)?'done':bad?'failed':''))},
      {text:'Publish APK ke B2',state:state==='publishing'?'active':state==='success'?'done':bad?'failed':''}
    ]);
    if(s.message)log(`Status: ${s.message}`);if(ok||bad){renderResults(s);if(s.run_url)log(`Actions: ${s.run_url}`);return s}await sleep(2500)}}

  async function build(){if(!selectedFile||busy)return;clearTimeout(pollTimer);setBusy(true);el.logBox.textContent='';el.resultArea.innerHTML='';el.resultArea.classList.add('hidden');el.speedLine.textContent='';try{saveConfig();setStatus('Membuat job',selectedFile.name,'START',3);const job=await api('/api/jobs',{method:'POST',body:{fileName:selectedFile.name,size:selectedFile.size,contentType:'application/zip'}});currentJobId=job.jobId;log(`Job ID: ${currentJobId}`);if(job.mode==='multipart'){log(`Upload multipart: ${Math.ceil(selectedFile.size/job.partSize)} bagian × ${fmtBytes(job.partSize)}.`);await uploadMultipart(job,selectedFile)}else{log('Upload binary langsung ke Backblaze B2.');await uploadSingle(job,selectedFile)}
      setStatus('Upload selesai','Memicu GitHub Actions…','START',47);const variant=document.querySelector('input[name="variant"]:checked').value;const started=await api(`/api/jobs/${encodeURIComponent(currentJobId)}/start`,{method:'POST',body:{variant}});if(started.runId)log(`GitHub run ID: ${started.runId}`);await pollJob();
    }catch(e){log(`ERROR: ${e.message}`);setStatus('Proses berhenti',e.message,'ERROR',100,'bad')}finally{setBusy(false)}}

  el.settingsButton.onclick=()=>el.setupCard.classList.toggle('hidden');
  el.saveButton.onclick=()=>{try{saveConfig();el.connectionResult.textContent='Pengaturan tersimpan.';el.setupCard.classList.add('hidden')}catch(e){el.connectionResult.textContent=e.message}};
  el.testButton.onclick=testConnection;el.dropZone.onclick=()=>el.fileInput.click();el.fileInput.onchange=()=>chooseFile(el.fileInput.files?.[0]);
  ['dragenter','dragover'].forEach(t=>el.dropZone.addEventListener(t,e=>{e.preventDefault();el.dropZone.classList.add('drag')}));['dragleave','drop'].forEach(t=>el.dropZone.addEventListener(t,e=>{e.preventDefault();el.dropZone.classList.remove('drag')}));el.dropZone.addEventListener('drop',e=>chooseFile(e.dataTransfer?.files?.[0]));el.buildButton.onclick=build;[el.workerInput,el.keyInput].forEach(i=>i.addEventListener('input',refresh));loadConfig();
})();
