// ============================================================================
// BlackDrop Cloud Space (Google Drive + S3 gateway)
// ============================================================================

let spaceMode = localStorage.getItem('blackdrop-space-mode') || 'local';

const UploadProgress = {
    items: new Map(),
    show() {
        const el = document.getElementById('uploadProgressPanel');
        if (el) el.style.display = 'flex';
    },
    hide() {
        const el = document.getElementById('uploadProgressPanel');
        if (el) el.style.display = 'none';
    },
    add(id, name) {
        this.show();
        this.items.set(id, { name, pct: 0, status: 'uploading' });
        this.render();
    },
    update(id, pct) {
        const item = this.items.get(id);
        if (!item) return;
        item.pct = Math.min(100, Math.round(pct));
        this.render();
    },
    done(id, ok = true, message) {
        const item = this.items.get(id);
        if (!item) return;
        item.pct = 100;
        item.status = ok ? 'done' : 'error';
        item.message = message || (ok ? 'Done' : 'Failed');
        this.render();
        setTimeout(() => {
            this.items.delete(id);
            this.render();
            if (this.items.size === 0) this.hide();
        }, ok ? 2500 : 5000);
    },
    render() {
        const list = document.getElementById('uploadProgressList');
        if (!list) return;
        list.innerHTML = '';
        for (const [id, item] of this.items) {
            const div = document.createElement('div');
            div.className = `upp-item ${item.status === 'done' ? 'done' : ''} ${item.status === 'error' ? 'error' : ''}`;
            div.innerHTML = `
                <div class="upp-name">${escapeHtml(item.name)}</div>
                <div class="upp-bar"><span style="width:${item.pct}%"></span></div>
                <div class="upp-meta"><span>${item.message || item.pct + '%'}</span></div>
            `;
            list.appendChild(div);
        }
    }
};

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function formatBytesCloud(bytes) {
    if (bytes == null || Number.isNaN(bytes)) return '—';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(i ? 1 : 0)} ${sizes[i]}`;
}

function cloudAuthHeaders() {
    const headers = {};
    if (typeof authToken !== 'undefined' && authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }
    return headers;
}

async function cloudFetch(url, options = {}) {
    const opts = { ...options };
    opts.headers = { ...cloudAuthHeaders(), ...(options.headers || {}) };
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
    return data;
}

function switchSpaceMode(mode) {
    spaceMode = mode === 'cloud' ? 'cloud' : 'local';
    localStorage.setItem('blackdrop-space-mode', spaceMode);

    document.querySelectorAll('.space-mode-btn').forEach(btn => {
        const active = btn.dataset.mode === spaceMode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    const localNav = document.getElementById('localNavLinks');
    const cloudNav = document.getElementById('cloudNavLinks');
    const localContent = document.getElementById('localContentArea');
    const cloudContent = document.getElementById('cloudContentArea');
    const syncBtn = document.getElementById('cloudSyncBtn');
    const folderBtn = document.getElementById('cloudNewFolderBtn');

    if (spaceMode === 'cloud') {
        if (localNav) localNav.style.display = 'none';
        if (cloudNav) cloudNav.style.display = '';
        if (localContent) localContent.style.display = 'none';
        if (cloudContent) cloudContent.style.display = '';
        if (syncBtn) syncBtn.style.display = '';
        if (folderBtn) folderBtn.style.display = '';
        CloudApp.init();
    } else {
        if (localNav) localNav.style.display = '';
        if (cloudNav) cloudNav.style.display = 'none';
        if (localContent) localContent.style.display = '';
        if (cloudContent) cloudContent.style.display = 'none';
        if (syncBtn) syncBtn.style.display = 'none';
        if (folderBtn) folderBtn.style.display = 'none';
        if (typeof updateStorageInfo === 'function') updateStorageInfo();
    }
}

function handleUploadClick(ev) {
    if (spaceMode === 'cloud') {
        document.getElementById('cloudFileInput')?.click();
        return;
    }
    if (ev?.shiftKey) {
        document.getElementById('folderInput')?.click();
    } else {
        document.getElementById('fileInput')?.click();
    }
}

const CloudApp = {
    currentFolderId: null,
    folders: [],
    files: [],
    accounts: [],
    view: 'files',
    initialized: false,

    async init() {
        const redirectInput = document.getElementById('googleRedirectUri');
        const hint = document.getElementById('cloudRedirectHint');
        const redirect = `${location.origin}/api/cloud/accounts/google/callback`;
        if (redirectInput && !redirectInput.value) redirectInput.value = redirect;
        if (hint) hint.textContent = redirect;

        const cloudInput = document.getElementById('cloudFileInput');
        if (cloudInput && !cloudInput._bound) {
            cloudInput._bound = true;
            cloudInput.addEventListener('change', () => {
                if (cloudInput.files?.length) {
                    this.uploadFiles([...cloudInput.files]);
                    cloudInput.value = '';
                }
            });
        }

        if (new URLSearchParams(location.search).get('cloud') === 'connected') {
            if (typeof showToast === 'function') showToast('Google Drive connected', 'success');
            history.replaceState({}, '', location.pathname);
            this.showView('settings');
        }

        await this.refreshStatus();
        this.showView(this.view || 'files');
        this.initialized = true;
    },

    showView(view) {
        this.view = view;
        document.querySelectorAll('#cloudNavLinks .nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.cloudView === view);
        });
        ['files', 'quota', 'settings', 'api'].forEach(v => {
            const el = document.getElementById(`cloudView${v.charAt(0).toUpperCase() + v.slice(1)}`);
            if (el) el.style.display = v === view ? '' : 'none';
        });
        if (view === 'files') this.loadFiles();
        if (view === 'quota') this.loadQuota();
        if (view === 'settings') this.loadSettings();
        if (view === 'api') this.loadApiKeys();
    },

    async refreshStatus() {
        try {
            const data = await cloudFetch('/api/cloud/status');
            this.accounts = data.accounts || [];
            this.updateCloudStorageBar(data);
            const modeEl = document.getElementById('routingMode');
            if (modeEl && data.routing?.mode) modeEl.value = data.routing.mode;
            const status = document.getElementById('googleConfigStatus');
            if (status) {
                status.textContent = data.googleConfigured
                    ? 'Google OAuth configured'
                    : 'Google OAuth not configured yet';
            }
        } catch (err) {
            console.warn('[cloud] status', err);
        }
    },

    updateCloudStorageBar(data) {
        const value = document.getElementById('storageValue');
        const fill = document.getElementById('storageFill');
        if (!value || !fill) return;
        const used = data.storage?.used || 0;
        const total = data.storage?.total;
        if (total) {
            value.textContent = `${formatBytesCloud(used)} / ${formatBytesCloud(total)}`;
            fill.style.width = `${Math.min(100, (used / total) * 100)}%`;
        } else {
            value.textContent = `${formatBytesCloud(used)} / ∞`;
            fill.style.width = '0%';
        }
    },

    async loadFiles() {
        try {
            const [filesRes, foldersRes] = await Promise.all([
                cloudFetch(`/api/cloud/files?folderId=${this.currentFolderId || 'root'}`),
                cloudFetch('/api/cloud/folders'),
            ]);
            this.files = filesRes.files || [];
            this.folders = (foldersRes.folders || []).filter(f =>
                (this.currentFolderId == null && !f.parentId) || f.parentId === this.currentFolderId
            );
            this.allFolders = foldersRes.folders || [];
            this.renderFiles();
            this.renderBreadcrumb();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    renderBreadcrumb() {
        const nav = document.getElementById('cloudBreadcrumb');
        if (!nav) return;
        let html = `<div class="breadcrumb-item home" onclick="CloudApp.navigateFolder(null)">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"/></svg>
            <span style="margin-left:6px;">Cloud</span>
        </div>`;
        if (this.currentFolderId) {
            const folder = (this.allFolders || []).find(f => f.id === this.currentFolderId);
            if (folder) {
                html += `<span class="breadcrumb-sep">/</span>
                    <div class="breadcrumb-item">${escapeHtml(folder.name)}</div>`;
            }
        }
        nav.innerHTML = html;
    },

    navigateFolder(folderId) {
        this.currentFolderId = folderId;
        this.loadFiles();
    },

    renderFiles() {
        const grid = document.getElementById('cloudFileGrid');
        const count = document.getElementById('cloudFileCount');
        if (!grid) return;
        const total = this.folders.length + this.files.length;
        if (count) count.textContent = total;

        if (total === 0) {
            grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;padding:3rem;text-align:center;opacity:0.7;">
                <p>No cloud files yet.</p>
                <p style="font-size:0.85rem;">Connect Drive/S3 in Cloud Settings, then upload.</p>
            </div>`;
            return;
        }

        grid.innerHTML = '';
        for (const folder of this.folders) {
            const card = document.createElement('div');
            card.className = 'file-card';
            card.ondblclick = () => this.navigateFolder(folder.id);
            card.innerHTML = `
                <div class="file-icon folder">📁</div>
                <div class="file-name">${escapeHtml(folder.name)}</div>
                <div class="file-meta">Folder</div>
            `;
            card.oncontextmenu = (e) => {
                e.preventDefault();
                if (confirm(`Delete folder "${folder.name}"?`)) this.deleteFolder(folder.id);
            };
            grid.appendChild(card);
        }

        for (const file of this.files) {
            const card = document.createElement('div');
            card.className = 'file-card cloud-file-card';
            card.innerHTML = `
                <span class="cloud-file-provider">${escapeHtml(file.provider === 's3' ? 'S3' : 'Drive')}</span>
                <div class="file-icon">📄</div>
                <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                <div class="file-meta">${formatBytesCloud(file.sizeBytes)}</div>
            `;
            card.onclick = () => this.openFileMenu(file);
            grid.appendChild(card);
        }
    },

    openFileMenu(file) {
        const action = prompt(`Actions for "${file.name}":\n1 = View\n2 = Download\n3 = Rename\n4 = Delete\n\nEnter number:`);
        if (action === '1') this.streamFile(file, 'view');
        else if (action === '2') this.streamFile(file, 'download');
        else if (action === '3') this.renameFile(file);
        else if (action === '4') this.deleteFile(file.id);
    },

    async streamFile(file, mode) {
        try {
            const res = await fetch(`/api/cloud/files/${file.id}/${mode}`, { headers: cloudAuthHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            if (mode === 'view') {
                window.open(url, '_blank');
            } else {
                const a = document.createElement('a');
                a.href = url;
                a.download = file.name;
                a.click();
            }
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async renameFile(file) {
        const name = prompt('New name:', file.name);
        if (!name || name === file.name) return;
        try {
            await cloudFetch(`/api/cloud/files/${file.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            this.loadFiles();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async deleteFile(id) {
        if (!confirm('Delete this cloud file?')) return;
        try {
            await cloudFetch(`/api/cloud/files/${id}`, { method: 'DELETE' });
            this.loadFiles();
            if (typeof showToast === 'function') showToast('Deleted', 'success');
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async deleteFolder(id) {
        try {
            await cloudFetch(`/api/cloud/folders/${id}`, { method: 'DELETE' });
            this.loadFiles();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async createFolder() {
        const name = prompt('Folder name:');
        if (!name) return;
        try {
            await cloudFetch('/api/cloud/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, parentId: this.currentFolderId }),
            });
            this.loadFiles();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async syncDrive() {
        try {
            if (typeof showToast === 'function') showToast('Syncing Drive…', 'info');
            const data = await cloudFetch('/api/cloud/files/sync-google', { method: 'POST' });
            const summary = (data.results || []).map(r =>
                r.error ? `Error: ${r.error}` : `+${r.created} ~${r.updated} -${r.deleted}`
            ).join(', ') || 'Done';
            if (typeof showToast === 'function') showToast(summary, 'success');
            this.loadFiles();
            this.refreshStatus();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async uploadFiles(fileList) {
        if (!fileList.length) return;
        for (const file of fileList) {
            const id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            UploadProgress.add(id, file.name);
            try {
                const form = new FormData();
                form.append('sizeBytes', String(file.size));
                form.append('fileName', file.name);
                form.append('mimeType', file.type || 'application/octet-stream');
                if (this.currentFolderId) form.append('folderId', this.currentFolderId);
                form.append('file', file);

                await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', '/api/cloud/uploads');
                    if (typeof authToken !== 'undefined' && authToken) {
                        xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
                    }
                    xhr.upload.onprogress = (e) => {
                        if (e.lengthComputable) UploadProgress.update(id, (e.loaded / e.total) * 100);
                    };
                    xhr.onload = () => {
                        let body = {};
                        try { body = JSON.parse(xhr.responseText); } catch (_) {}
                        if (xhr.status >= 200 && xhr.status < 300 && (body.completed?.length || !body.failed?.length)) {
                            UploadProgress.done(id, true);
                            resolve(body);
                        } else {
                            const msg = body.failed?.[0]?.error || body.error || `HTTP ${xhr.status}`;
                            UploadProgress.done(id, false, msg);
                            reject(new Error(msg));
                        }
                    };
                    xhr.onerror = () => {
                        UploadProgress.done(id, false, 'Network error');
                        reject(new Error('Network error'));
                    };
                    xhr.send(form);
                });
            } catch (err) {
                console.error(err);
            }
        }
        this.loadFiles();
        this.refreshStatus();
    },

    async loadQuota() {
        const list = document.getElementById('cloudQuotaList');
        if (!list) return;
        list.innerHTML = '<p style="opacity:0.6;">Refreshing quotas…</p>';
        try {
            const data = await cloudFetch('/api/cloud/summary');
            this.accounts = data.accounts || [];
            if (!this.accounts.length) {
                list.innerHTML = '<p style="opacity:0.7;">No connected accounts. Open Cloud Settings to connect Drive or S3.</p>';
                return;
            }
            list.innerHTML = '';
            for (const acc of this.accounts) {
                const q = acc.quota || {};
                const used = q.usedBytes || 0;
                const total = q.totalBytes;
                const pct = total ? Math.min(100, (used / total) * 100) : 0;
                const card = document.createElement('div');
                card.className = 'cloud-quota-card';
                card.innerHTML = `
                    <div style="display:flex;justify-content:space-between;gap:1rem;">
                        <div class="cloud-account-meta">
                            <strong>${escapeHtml(acc.displayName || acc.email)}</strong>
                            <span>${escapeHtml(acc.email)} · <span class="cloud-badge ${acc.provider === 's3' ? 's3' : ''}">${acc.provider === 's3' ? 'S3' : 'Drive'}</span></span>
                        </div>
                        <div style="text-align:right;font-size:0.85rem;">
                            ${formatBytesCloud(used)}${total != null ? ' / ' + formatBytesCloud(total) : ''}
                        </div>
                    </div>
                    <div class="quota-bar"><span style="width:${pct}%"></span></div>
                    <div style="display:flex;justify-content:space-between;margin-top:0.5rem;">
                        <span style="font-size:0.75rem;opacity:0.65;">Synced ${q.lastSyncedAt ? new Date(q.lastSyncedAt).toLocaleString() : '—'}</span>
                        <button class="btn-secondary" style="padding:0.25rem 0.6rem;font-size:0.75rem;" onclick="CloudApp.syncQuota('${acc.id}')">Refresh</button>
                    </div>
                `;
                list.appendChild(card);
            }
            this.updateCloudStorageBar({
                storage: {
                    used: this.accounts.reduce((s, a) => s + (a.quota?.usedBytes || 0), 0),
                    total: this.accounts.every(a => a.quota?.totalBytes != null)
                        ? this.accounts.reduce((s, a) => s + (a.quota?.totalBytes || 0), 0)
                        : null,
                },
            });
        } catch (err) {
            list.innerHTML = `<p style="color:#f87171;">${escapeHtml(err.message)}</p>`;
        }
    },

    async syncQuota(id) {
        try {
            await cloudFetch(`/api/cloud/accounts/${id}/sync-quota`, { method: 'POST' });
            this.loadQuota();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async loadSettings() {
        await this.refreshStatus();
        this.renderAccounts();
        try {
            const cfg = await cloudFetch('/api/cloud/google-config');
            const status = document.getElementById('googleConfigStatus');
            if (status) {
                status.textContent = cfg.configured
                    ? `Configured · redirect ${cfg.redirectUri || ''}`
                    : 'Not configured';
            }
            const policy = await cloudFetch('/api/cloud/routing-policy');
            const modeEl = document.getElementById('routingMode');
            if (modeEl && policy.policy?.mode) modeEl.value = policy.policy.mode;
        } catch (_) { /* ignore */ }
    },

    renderAccounts() {
        const list = document.getElementById('cloudAccountsList');
        if (!list) return;
        if (!this.accounts.length) {
            list.innerHTML = '<p style="opacity:0.65;font-size:0.85rem;">No accounts connected yet.</p>';
            return;
        }
        list.innerHTML = '';
        for (const acc of this.accounts) {
            const row = document.createElement('div');
            row.className = 'cloud-account-row';
            row.innerHTML = `
                <div class="cloud-account-meta">
                    <strong>${escapeHtml(acc.displayName || acc.email)}</strong>
                    <span><span class="cloud-badge ${acc.provider === 's3' ? 's3' : ''}">${acc.provider === 's3' ? 'S3' : 'Drive'}</span> ${escapeHtml(acc.email)}
                    ${acc.lastError ? ' · <span style="color:#f87171;">' + escapeHtml(acc.lastError) + '</span>' : ''}</span>
                </div>
                <button class="btn-danger" style="padding:0.35rem 0.7rem;font-size:0.8rem;" onclick="CloudApp.disconnect('${acc.id}')">Disconnect</button>
            `;
            list.appendChild(row);
        }
    },

    async saveGoogleConfig() {
        const clientId = document.getElementById('googleClientId')?.value.trim();
        const clientSecret = document.getElementById('googleClientSecret')?.value.trim();
        const redirectUri = document.getElementById('googleRedirectUri')?.value.trim();
        try {
            await cloudFetch('/api/cloud/google-config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId, clientSecret, redirectUri }),
            });
            if (typeof showToast === 'function') showToast('Google config saved', 'success');
            this.refreshStatus();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async connectGoogle() {
        try {
            const data = await cloudFetch('/api/cloud/accounts/google/connect-url');
            window.location.href = data.url;
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    showS3Form() {
        const el = document.getElementById('s3ConnectForm');
        if (el) el.style.display = '';
    },
    hideS3Form() {
        const el = document.getElementById('s3ConnectForm');
        if (el) el.style.display = 'none';
    },

    async connectS3() {
        const body = {
            name: document.getElementById('s3Name')?.value.trim(),
            bucket: document.getElementById('s3Bucket')?.value.trim(),
            region: document.getElementById('s3Region')?.value.trim() || 'auto',
            endpoint: document.getElementById('s3Endpoint')?.value.trim() || null,
            accessKeyId: document.getElementById('s3AccessKey')?.value.trim(),
            secretAccessKey: document.getElementById('s3SecretKey')?.value.trim(),
            prefix: document.getElementById('s3Prefix')?.value.trim() || 'blackdrop',
            quotaBytes: document.getElementById('s3Quota')?.value || null,
            forcePathStyle: !!document.getElementById('s3ForcePath')?.checked,
        };
        try {
            await cloudFetch('/api/cloud/accounts/s3', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (typeof showToast === 'function') showToast('S3 connected', 'success');
            this.hideS3Form();
            this.loadSettings();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async disconnect(id) {
        if (!confirm('Disconnect this account? Cloud file records will be marked deleted.')) return;
        try {
            await cloudFetch(`/api/cloud/accounts/${id}`, { method: 'DELETE' });
            this.loadSettings();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async saveRouting() {
        const mode = document.getElementById('routingMode')?.value || 'most_available';
        try {
            await cloudFetch('/api/cloud/routing-policy', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode, priorityAccountIds: this.accounts.map(a => a.id) }),
            });
            if (typeof showToast === 'function') showToast('Routing saved', 'success');
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async loadApiKeys() {
        const list = document.getElementById('apiKeysList');
        const docs = document.getElementById('apiDocsCurl');
        if (docs) {
            docs.textContent = `curl -X POST ${location.origin}/api/v1/uploads \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -F "sizeBytes=12345" \\
  -F "fileName=photo.jpg" \\
  -F "mimeType=image/jpeg" \\
  -F "file=@photo.jpg"`;
        }
        try {
            const data = await cloudFetch('/api/cloud/api-keys');
            if (!list) return;
            if (!data.keys?.length) {
                list.innerHTML = '<p style="opacity:0.65;font-size:0.85rem;">No API keys yet.</p>';
                return;
            }
            list.innerHTML = '';
            for (const key of data.keys) {
                const row = document.createElement('div');
                row.className = 'cloud-account-row';
                row.innerHTML = `
                    <div class="cloud-account-meta">
                        <strong>${escapeHtml(key.name)}</strong>
                        <span>${escapeHtml(key.keyPrefix)}… · last used ${key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'never'}</span>
                    </div>
                    <button class="btn-danger" style="padding:0.35rem 0.7rem;font-size:0.8rem;" onclick="CloudApp.revokeApiKey('${key.id}')">Revoke</button>
                `;
                list.appendChild(row);
            }
        } catch (err) {
            if (list) list.innerHTML = `<p style="color:#f87171;">${escapeHtml(err.message)}</p>`;
        }
    },

    async createApiKey() {
        const name = document.getElementById('apiKeyName')?.value.trim() || 'Default';
        try {
            const data = await cloudFetch('/api/cloud/api-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const box = document.getElementById('apiKeySecretOnce');
            if (box) {
                box.style.display = '';
                box.innerHTML = `<strong>Copy now (shown once):</strong><br>${escapeHtml(data.secret)}`;
            }
            this.loadApiKeys();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },

    async revokeApiKey(id) {
        if (!confirm('Revoke this API key?')) return;
        try {
            await cloudFetch(`/api/cloud/api-keys/${id}`, { method: 'DELETE' });
            this.loadApiKeys();
        } catch (err) {
            if (typeof showToast === 'function') showToast(err.message, 'error');
        }
    },
};

// Hook drop uploads into cloud mode
document.addEventListener('DOMContentLoaded', () => {
    switchSpaceMode(spaceMode);

    // Intercept drop when in cloud mode (script.js also listens; we add after)
    document.body.addEventListener('drop', (e) => {
        if (spaceMode !== 'cloud') return;
        const files = [...(e.dataTransfer?.files || [])];
        if (files.length) {
            e.preventDefault();
            e.stopPropagation();
            CloudApp.uploadFiles(files);
        }
    }, true);
});

// Export for inline handlers
window.switchSpaceMode = switchSpaceMode;
window.handleUploadClick = handleUploadClick;
window.CloudApp = CloudApp;
window.UploadProgress = UploadProgress;
