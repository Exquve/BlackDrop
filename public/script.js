const socket = io();

// ============================================================================
// STATE
// ============================================================================
let allFiles = [];
let currentFilter = 'all';
let currentSort = 'date';
let sortAscending = false;
let selectedFiles = new Set();
let isListView = false;
let currentPath = '/';
let authToken = localStorage.getItem('blackdrop-token');
let currentUser = null;
let currentUserRole = null;
let allTags = {};

// ============================================================================
// DOM ELEMENTS
// ============================================================================
const fileGrid = document.getElementById('fileGrid');
const searchInput = document.getElementById('searchInput');
const fileInput = document.getElementById('fileInput');
const dropOverlay = document.getElementById('dropOverlay');
const contextMenu = document.getElementById('contextMenu');
const gridContextMenu = document.getElementById('gridContextMenu');
const toastContainer = document.getElementById('toastContainer');
const sectionTitle = document.getElementById('sectionTitle');
const fileCount = document.getElementById('fileCount');
const sortMenu = document.getElementById('sortMenu');
const sortBtn = document.getElementById('sortBtn');
const sortLabel = document.getElementById('sortLabel');
const themeSwitch = document.getElementById('themeSwitch');
const breadcrumbNav = document.getElementById('breadcrumbNav');

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
    await checkAuthStatus();
    loadTheme();
    updateStorageInfo();
    setupKeyboardShortcuts();
    setupGridContextMenu();
    setupAdvancedSearch();
    setupMobileMenu();
    loadTags();
});

// ============================================================================
// MOBILE MENU
// ============================================================================
function setupMobileMenu() {
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');

    if (mobileMenuBtn && sidebar) {
        mobileMenuBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            sidebarOverlay?.classList.toggle('active');
        });
    }

    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', () => {
            sidebar?.classList.remove('open');
            sidebarOverlay.classList.remove('active');
        });
    }

    // Close sidebar when clicking on nav items (mobile)
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                sidebar?.classList.remove('open');
                sidebarOverlay?.classList.remove('active');
            }
        });
    });
}

// ============================================================================
// AUTHENTICATION
// ============================================================================
async function checkAuthStatus() {
    try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();

        if (data.authEnabled && !authToken) {
            showLoginModal();
        } else {
            await loadCurrentUser();
            fetchContents();
        }
    } catch (e) {
        fetchContents();
    }
}

async function loadCurrentUser() {
    try {
        const res = await fetch('/api/auth/me', { headers: getAuthHeaders() });
        if (res.ok) {
            const data = await res.json();
            currentUser = data.username;
            currentUserRole = data.role;
            updateAdminPanelVisibility();
        }
    } catch (e) { }
}

function updateAdminPanelVisibility() {
    const adminLink = document.querySelector('.nav-item[onclick*="admin-panel"]');
    if (adminLink) {
        adminLink.style.display = currentUserRole === 'superadmin' ? '' : 'none';
    }
}

function showLoginModal() {
    const modal = document.getElementById('loginModal');
    if (modal) modal.classList.add('active');
}

window.login = async () => {
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (res.ok) {
            const data = await res.json();
            authToken = data.token;
            currentUser = data.username;
            currentUserRole = data.role;
            localStorage.setItem('blackdrop-token', authToken);
            document.getElementById('loginModal').classList.remove('active');
            updateAdminPanelVisibility();
            fetchContents();
            showToast(`Hoş geldin, ${data.username}!`, 'success');
        } else {
            const err = await res.json();
            errorEl.textContent = err.error || 'Giriş başarısız';
            errorEl.style.display = 'block';
        }
    } catch (e) {
        errorEl.textContent = 'Bağlantı hatası';
        errorEl.style.display = 'block';
    }
};

window.logout = () => {
    authToken = null;
    currentUser = null;
    currentUserRole = null;
    localStorage.removeItem('blackdrop-token');
    location.reload();
};

function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    return headers;
}

// ============================================================================
// THEME
// ============================================================================
function loadTheme() {
    const theme = localStorage.getItem('blackdrop-theme') || 'dark';
    if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        themeSwitch?.classList.remove('active');
    } else {
        document.documentElement.removeAttribute('data-theme');
        themeSwitch?.classList.add('active');
    }
}

window.toggleTheme = () => {
    const isDark = themeSwitch.classList.contains('active');
    if (isDark) {
        document.documentElement.setAttribute('data-theme', 'light');
        themeSwitch.classList.remove('active');
        localStorage.setItem('blackdrop-theme', 'light');
    } else {
        document.documentElement.removeAttribute('data-theme');
        themeSwitch.classList.add('active');
        localStorage.setItem('blackdrop-theme', 'dark');
    }
};

// ============================================================================
// STORAGE INFO
// ============================================================================
function updateStorageInfo() {
    fetch('/storage')
        .then(res => res.json())
        .then(data => {
            const used = formatSize(data.used);
            const total = formatSize(data.total);
            const percent = Math.min((data.used / data.total) * 100, 100);
            document.getElementById('storageValue').textContent = `${used} / ${total}`;
            document.getElementById('storageFill').style.width = `${percent}%`;
        })
        .catch(() => {
            document.getElementById('storageValue').textContent = '-- / --';
        });
}

// ============================================================================
// SOCKET.IO EVENTS
// ============================================================================
socket.on('file:uploaded', (data) => {
    const uploadPath = data.parentPath === '/' ? '/' : '/' + data.parentPath;
    if (uploadPath === currentPath || (uploadPath === '/' && currentPath === '/')) {
        allFiles.unshift(data.file);
        applyFilterAndRender();
    }
    showToast(`Dosya yüklendi: ${data.file.name}`, 'success');
    updateStorageInfo();
});

socket.on('file:deleted', (data) => {
    allFiles = allFiles.filter(f => f.name !== data.name);
    selectedFiles.delete(data.name);
    applyFilterAndRender();
    updateStorageInfo();
});

socket.on('file:renamed', (data) => {
    const file = allFiles.find(f => f.name === data.oldName);
    if (file) {
        file.name = data.newName;
        applyFilterAndRender();
    }
});

socket.on('folder:created', (data) => {
    const folderPath = data.parentPath === '/' ? '/' : '/' + data.parentPath;
    if (folderPath === currentPath) {
        allFiles.unshift(data.folder);
        applyFilterAndRender();
    }
    showToast(`Klasör oluşturuldu: ${data.folder.name}`, 'success');
});

socket.on('folder:deleted', (data) => {
    const folderName = data.path.split('/').pop();
    allFiles = allFiles.filter(f => f.name !== folderName);
    applyFilterAndRender();
    updateStorageInfo();
});

socket.on('activity:new', (data) => {
    // Could show real-time activity notifications
});

// ============================================================================
// CONTENT FETCHING
// ============================================================================
function fetchContents() {
    showLoadingSkeletons();
    const pathParam = currentPath === '/' ? '' : currentPath.replace(/^\//, '');

    fetch(`/api/contents?path=${encodeURIComponent(pathParam)}`, {
        headers: getAuthHeaders()
    })
        .then(res => {
            if (res.status === 401) {
                showLoginModal();
                throw new Error('Auth required');
            }
            return res.json();
        })
        .then(data => {
            allFiles = data;
            updateBreadcrumbs();
            applyFilterAndRender();
        })
        .catch(err => {
            if (err.message !== 'Auth required') {
                showToast('Dosyalar yüklenemedi', 'error');
            }
            fileGrid.innerHTML = '';
        });
}

function fetchFiles() {
    fetchContents();
}

function showLoadingSkeletons() {
    fileGrid.innerHTML = '';
    for (let i = 0; i < 8; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton-card';
        skeleton.innerHTML = `
            <div class="skeleton skeleton-preview"></div>
            <div class="skeleton skeleton-text"></div>
            <div class="skeleton skeleton-text-sm"></div>
        `;
        fileGrid.appendChild(skeleton);
    }
}

// ============================================================================
// TAGS
// ============================================================================
async function loadTags() {
    try {
        const res = await fetch('/api/tags', { headers: getAuthHeaders() });
        if (res.ok) {
            allTags = await res.json();
        }
    } catch (e) { }
}

async function addTag(filePath, tag) {
    try {
        await fetch('/api/tags', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ path: filePath, tag })
        });
        if (!allTags[filePath]) allTags[filePath] = [];
        allTags[filePath].push(tag);
        showToast(`Etiket eklendi: ${tag}`, 'success');
    } catch (e) {
        showToast('Etiket eklenemedi', 'error');
    }
}

async function removeTag(filePath, tag) {
    try {
        await fetch('/api/tags', {
            method: 'DELETE',
            headers: getAuthHeaders(),
            body: JSON.stringify({ path: filePath, tag })
        });
        if (allTags[filePath]) {
            allTags[filePath] = allTags[filePath].filter(t => t !== tag);
        }
    } catch (e) { }
}

// ============================================================================
// FAVORITES
// ============================================================================
async function toggleFavorite(filePath) {
    const file = allFiles.find(f => {
        const fp = currentPath === '/' ? f.name : currentPath.replace(/^\//, '') + '/' + f.name;
        return fp === filePath || f.name === filePath;
    });

    if (!file) return;

    const fullPath = currentPath === '/' ? file.name : currentPath.replace(/^\//, '') + '/' + file.name;

    try {
        if (file.isFavorite) {
            await fetch('/api/favorites', {
                method: 'DELETE',
                headers: getAuthHeaders(),
                body: JSON.stringify({ path: fullPath })
            });
            file.isFavorite = false;
            showToast('Favorilerden kaldırıldı', 'success');
        } else {
            await fetch('/api/favorites', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ path: fullPath })
            });
            file.isFavorite = true;
            showToast('Favorilere eklendi', 'success');
        }
        applyFilterAndRender();
    } catch (e) {
        showToast('İşlem başarısız', 'error');
    }
}

// ============================================================================
// SORTING
// ============================================================================
function sortFiles(files) {
    const sorted = [...files];
    sorted.sort((a, b) => {
        // Folders always first
        if (a.isFolder && !b.isFolder) return -1;
        if (!a.isFolder && b.isFolder) return 1;

        let comparison = 0;
        switch (currentSort) {
            case 'name':
                comparison = a.name.localeCompare(b.name);
                break;
            case 'size':
                comparison = b.size - a.size;
                break;
            case 'type':
                comparison = (a.type || '').localeCompare(b.type || '');
                break;
            case 'date':
            default:
                comparison = new Date(b.date) - new Date(a.date);
                break;
        }
        return sortAscending ? -comparison : comparison;
    });
    return sorted;
}

sortBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    sortMenu.classList.toggle('active');
});

document.querySelectorAll('.sort-option').forEach(option => {
    option.addEventListener('click', (e) => {
        const sort = e.currentTarget.dataset.sort;
        if (currentSort === sort) {
            sortAscending = !sortAscending;
        } else {
            currentSort = sort;
            sortAscending = false;
        }
        document.querySelectorAll('.sort-option').forEach(o => o.classList.remove('active'));
        e.currentTarget.classList.add('active');
        sortLabel.textContent = e.currentTarget.textContent.trim();
        sortMenu.classList.remove('active');
        applyFilterAndRender();
    });
});

document.addEventListener('click', () => {
    sortMenu?.classList.remove('active');
});

// ============================================================================
// FILTERING & RENDERING
// ============================================================================
function applyFilterAndRender() {
    let filtered = allFiles;

    // Filter by category
    if (currentFilter === 'favorites') {
        filtered = filtered.filter(f => f.isFavorite);
    } else if (currentFilter !== 'all') {
        if (currentFilter === 'media') {
            filtered = filtered.filter(f => f.type === 'image' || f.type === 'video' || f.type === 'audio');
        } else {
            filtered = filtered.filter(f => f.type === currentFilter);
        }
    }

    // Filter by search
    const searchTerm = searchInput?.value.toLowerCase() || '';
    if (searchTerm) {
        filtered = filtered.filter(f => f.name.toLowerCase().includes(searchTerm));
    }

    // Sort
    filtered = sortFiles(filtered);

    // Update count
    const countEl = document.getElementById('fileCount');
    if (countEl) countEl.textContent = filtered.length;

    renderGrid(filtered);
}

// ============================================================================
// ICONS
// ============================================================================
function getIconForType(type) {
    const icons = {
        folder: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>`,
        video: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`,
        document: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
        image: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`,
        audio: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/></svg>`,
        pdf: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>`,
        code: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>`,
        markdown: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"/></svg>`,
        archive: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>`,
        other: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>`
    };
    return icons[type] || icons.other;
}

function getFileExtension(filename) {
    return filename.split('.').pop().toUpperCase();
}

function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;

    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        if (hours < 1) {
            const mins = Math.floor(diff / 60000);
            return mins <= 1 ? 'Az önce' : `${mins}dk önce`;
        }
        return `${hours}sa önce`;
    }

    if (diff < 604800000) {
        const days = Math.floor(diff / 86400000);
        return days === 1 ? 'Dün' : `${days}g önce`;
    }

    return date.toLocaleDateString('tr-TR', { month: 'short', day: 'numeric' });
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function renderGrid(files) {
    fileGrid.innerHTML = '';

    if (files.length === 0) {
        fileGrid.innerHTML = `
            <div class="empty-state">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" 
                        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
                </svg>
                <h3>Dosya yok</h3>
                <p>Dosyaları sürükleyip bırakın veya yükle butonunu kullanın</p>
            </div>
        `;
        return;
    }

    files.forEach((file, index) => {
        const card = document.createElement('div');
        card.className = 'file-card';
        card.draggable = true;
        card.setAttribute('data-name', file.name);
        card.setAttribute('data-isfolder', file.isFolder);

        if (selectedFiles.has(file.name)) card.classList.add('selected');
        card.setAttribute('data-filename', file.name);
        card.style.animationDelay = `${index * 0.03}s`;

        let previewHtml = '';
        if (file.type === 'image') {
            const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');
            previewHtml = `<img src="/api/download/${encodeURIComponent(file.name)}?parentPath=${encodeURIComponent(parentPath)}" loading="lazy" alt="${file.name}">`;
        } else if (file.type === 'video') {
            previewHtml = `<img src="${getVideoThumbnailUrl(file.name)}" loading="lazy" alt="${file.name}" onerror="this.parentElement.innerHTML='${getIconForType('video').replace(/'/g, "\\'")}'">`;
        } else {
            previewHtml = getIconForType(file.type);
        }

        const ext = file.isFolder ? 'FOLDER' : getFileExtension(file.name);
        const favoriteClass = file.isFavorite ? 'active' : '';
        const tagsHtml = (file.tags || []).map(t => `<span class="file-tag">${t}</span>`).join('');

        card.innerHTML = `
            <div class="file-checkbox">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/>
                </svg>
            </div>
            <button class="favorite-btn ${favoriteClass}" onclick="event.stopPropagation(); toggleFavorite('${file.name}')" title="Favorilere ekle">
                <svg fill="${file.isFavorite ? 'currentColor' : 'none'}" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
                </svg>
            </button>
            <div class="file-preview">
                ${previewHtml}
                <span class="file-type-badge">${ext}</span>
            </div>
            <div class="file-details">
                <div class="file-name" title="${file.name}">${file.name}</div>
                <div class="file-tags">${tagsHtml}</div>
                <div class="file-meta">
                    <span class="file-size">${formatSize(file.size)}</span>
                    <span class="file-date">${formatDate(file.date)}</span>
                    ${file.downloadCount ? `<span class="download-count" title="İndirme sayısı">↓${file.downloadCount}</span>` : ''}
                </div>
            </div>
        `;

        // Events
        card.addEventListener('dblclick', () => previewFile(file.name));
        card.addEventListener('contextmenu', (e) => showContextMenu(e, file.name));
        card.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) return;

            if (e.ctrlKey || e.metaKey) {
                if (selectedFiles.has(file.name)) {
                    selectedFiles.delete(file.name);
                    card.classList.remove('selected');
                } else {
                    selectedFiles.add(file.name);
                    card.classList.add('selected');
                }
            } else {
                selectedFiles.clear();
                document.querySelectorAll('.file-card').forEach(c => c.classList.remove('selected'));
                selectedFiles.add(file.name);
                card.classList.add('selected');
            }
            updateBulkActions();
        });

        // Drag & Drop
        card.addEventListener('dragstart', handleDragStart);
        card.addEventListener('dragend', handleDragEnd);
        if (file.isFolder) {
            card.addEventListener('dragover', handleDragOver);
            card.addEventListener('dragleave', handleDragLeave);
            card.addEventListener('drop', handleDrop);
        }

        fileGrid.appendChild(card);
    });
}

// ============================================================================
// BULK ACTIONS
// ============================================================================
function updateBulkActions() {
    const bulkBar = document.getElementById('bulkActionsBar');
    if (!bulkBar) return;

    if (selectedFiles.size > 1) {
        bulkBar.style.display = 'flex';
        document.getElementById('selectedCount').textContent = `${selectedFiles.size} oge secili`;
    } else {
        bulkBar.style.display = 'none';
    }
}

window.bulkMove = () => showBatchMoveModal();
window.bulkTag = () => showBatchTagModal();
window.bulkRename = () => showBatchRenameModal();

window.bulkDelete = async () => {
    if (selectedFiles.size === 0) return;
    showBulkDeleteModal();
};

window.bulkDownloadZip = async () => {
    if (selectedFiles.size === 0) return;

    const paths = [...selectedFiles].map(name =>
        currentPath === '/' ? name : `${currentPath.replace(/^\//, '')}/${name}`
    );

    try {
        const res = await fetch('/api/download-zip', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ paths })
        });

        if (res.ok) {
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'download.zip';
            a.click();
            URL.revokeObjectURL(url);
            showToast('Zip indiriliyor...', 'success');
        }
    } catch (e) {
        showToast('Zip oluşturulamadı', 'error');
    }
};

window.clearSelection = () => {
    selectedFiles.clear();
    document.querySelectorAll('.file-card').forEach(c => c.classList.remove('selected'));
    updateBulkActions();
};

// ============================================================================
// SIDEBAR FILTERING
// ============================================================================
window.filterFiles = (type) => {
    currentFilter = type;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-filter="${type}"]`)?.classList.add('active');

    const titles = {
        'all': 'Tüm Dosyalar',
        'media': 'Medya',
        'document': 'Belgeler',
        'favorites': 'Favoriler',
        'recent': 'Son Açılanlar'
    };
    if (sectionTitle) {
        sectionTitle.innerHTML = `${titles[type] || 'Dosyalar'} <span class="file-count" id="fileCount">0</span>`;
    }

    if (type === 'recent') {
        fetchRecentFiles();
    } else {
        applyFilterAndRender();
    }
};

async function fetchRecentFiles() {
    try {
        const res = await fetch('/api/recent', { headers: getAuthHeaders() });
        if (res.ok) {
            const recent = await res.json();
            // Transform recent to display format
            showToast('Son açılanlar yüklendi', 'success');
        }
    } catch (e) { }
}

searchInput?.addEventListener('input', applyFilterAndRender);

// ============================================================================
// VIEW TOGGLE
// ============================================================================
const viewToggleBtn = document.getElementById('viewToggleBtn');
const viewIcon = document.getElementById('viewIcon');

viewToggleBtn?.addEventListener('click', () => {
    isListView = !isListView;
    fileGrid.classList.toggle('list-view', isListView);
    if (viewIcon) {
        viewIcon.innerHTML = isListView
            ? `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/>`
            : `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>`;
    }
});

// ============================================================================
// UPLOAD
// ============================================================================
fileInput?.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';  // Reset so same files can be selected again
});

// Close/hide upload status bar
document.getElementById('uploadMinimizeBtn')?.addEventListener('click', () => {
    const uploadStatus = document.getElementById('uploadStatus');
    if (uploadStatus) uploadStatus.style.display = 'none';
});

let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
    const types = e.dataTransfer?.types || [];
    const isExternalFile = types.includes('Files') && !types.includes('text/plain');
    if (isExternalFile) {
        e.preventDefault();
        dragCounter++;
        dropOverlay?.classList.add('active');
    }
});

document.addEventListener('dragleave', (e) => {
    dragCounter--;
    if (dragCounter === 0) {
        dropOverlay?.classList.remove('active');
    }
});

document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay?.classList.remove('active');

    const isInternalDrag = e.dataTransfer?.getData('text/plain');
    if (!isInternalDrag && e.dataTransfer?.files?.length) {
        handleFiles(e.dataTransfer.files);
    }
});

document.addEventListener('dragover', (e) => e.preventDefault());

function handleFiles(files) {
    if (!files?.length) return;
    [...files].forEach(file => uploadQueue.add(file));
}

// ============================================================================
// UPLOAD QUEUE SYSTEM
// ============================================================================
const uploadQueue = {
    queue: [],          // Files waiting to be uploaded
    active: null,       // Currently uploading file info
    completed: 0,       // Count of completed uploads in current batch
    failed: 0,          // Count of failed uploads
    totalInBatch: 0,    // Total files in current batch
    xhr: null,          // Current XMLHttpRequest

    add(file) {
        this.queue.push(file);
        this.totalInBatch++;
        this.updateUI();
        if (!this.active) {
            this.processNext();
        }
    },

    processNext() {
        if (this.queue.length === 0) {
            // All done
            this.finish();
            return;
        }

        const file = this.queue.shift();
        this.active = { name: file.name, size: file.size, progress: 0 };
        this.updateUI();

        const formData = new FormData();
        formData.append('file', file);

        const xhr = new XMLHttpRequest();
        this.xhr = xhr;
        const parentPathQuery = currentPath === '/' ? '' : `?parentPath=${encodeURIComponent(currentPath)}`;
        xhr.open('POST', `/upload${parentPathQuery}`, true);

        if (authToken) {
            xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
        }

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && this.active) {
                this.active.progress = (e.loaded / e.total) * 100;
                this.updateUI();
            }
        };

        xhr.onload = () => {
            if (xhr.status === 200) {
                this.completed++;
            } else {
                this.failed++;
                showToast(`Yukleme basarisiz: ${file.name}`, 'error');
            }
            this.active = null;
            this.processNext();
        };

        xhr.onerror = () => {
            this.failed++;
            showToast(`Yukleme hatasi: ${file.name}`, 'error');
            this.active = null;
            this.processNext();
        };

        xhr.send(formData);
    },

    finish() {
        const statusTitle = document.getElementById('uploadStatusTitle');
        const uploadFileName = document.getElementById('uploadFileName');
        const uploadProgress = document.getElementById('uploadProgress');

        if (this.failed > 0) {
            if (statusTitle) statusTitle.textContent = `Tamamlandi (${this.failed} basarisiz)`;
        } else {
            if (statusTitle) statusTitle.textContent = 'Tamamlandi!';
        }
        if (uploadFileName) uploadFileName.textContent = `${this.completed} dosya yuklendi`;
        if (uploadProgress) uploadProgress.style.width = '100%';

        const queueList = document.getElementById('uploadQueueList');
        if (queueList) queueList.style.display = 'none';

        setTimeout(() => {
            const uploadStatus = document.getElementById('uploadStatus');
            if (uploadStatus) uploadStatus.style.display = 'none';
            if (uploadProgress) uploadProgress.style.width = '0%';
            this.reset();
        }, 2000);
    },

    reset() {
        this.queue = [];
        this.active = null;
        this.completed = 0;
        this.failed = 0;
        this.totalInBatch = 0;
        this.xhr = null;
    },

    updateUI() {
        const uploadStatus = document.getElementById('uploadStatus');
        const statusTitle = document.getElementById('uploadStatusTitle');
        const uploadFileName = document.getElementById('uploadFileName');
        const uploadProgress = document.getElementById('uploadProgress');
        const queueList = document.getElementById('uploadQueueList');

        if (uploadStatus) uploadStatus.style.display = 'block';

        const current = this.completed + this.failed + 1;
        const total = this.totalInBatch;

        if (statusTitle) {
            if (total > 1) {
                statusTitle.textContent = `Yukleniyor... (${current}/${total})`;
            } else {
                statusTitle.textContent = 'Yukleniyor...';
            }
        }

        if (this.active) {
            if (uploadFileName) uploadFileName.textContent = this.active.name;
            if (uploadProgress) uploadProgress.style.width = this.active.progress + '%';
        }

        // Show queue list if more than 1 file
        if (queueList && total > 1) {
            queueList.style.display = 'block';
            const items = [];
            // Completed
            for (let i = 0; i < this.completed; i++) {
                items.push(`<div style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;font-size:0.8rem;color:var(--text-secondary);">
                    <span style="color:#22c55e;">✓</span> <span>Yuklendi</span>
                </div>`);
            }
            // Failed
            for (let i = 0; i < this.failed; i++) {
                items.push(`<div style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;font-size:0.8rem;color:#ef4444;">
                    <span>✗</span> <span>Basarisiz</span>
                </div>`);
            }
            // Current
            if (this.active) {
                items.push(`<div style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;font-size:0.8rem;color:var(--text-primary);font-weight:500;">
                    <span style="color:var(--accent);">⬆</span> <span>${this.active.name}</span>
                    <span style="margin-left:auto;color:var(--text-secondary);">${Math.round(this.active.progress)}%</span>
                </div>`);
            }
            // Queued
            this.queue.forEach(f => {
                items.push(`<div style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;font-size:0.8rem;color:var(--text-tertiary);">
                    <span>⏳</span> <span>${f.name}</span>
                    <span style="margin-left:auto;">${formatSize(f.size)}</span>
                </div>`);
            });
            queueList.innerHTML = items.join('');
        } else if (queueList) {
            queueList.style.display = 'none';
        }
    }
};

// ============================================================================
// CONTEXT MENU
// ============================================================================
let selectedFilename = null;

function showContextMenu(e, filename) {
    e.preventDefault();
    selectedFilename = filename;

    const file = allFiles.find(f => f.name === filename);
    const isFolder = file?.isFolder;

    // Update context menu items based on file type
    const ctxPreview = document.getElementById('ctxPreview');
    const ctxShare = document.getElementById('ctxShare');

    if (ctxPreview) ctxPreview.style.display = isFolder ? 'none' : 'flex';

    contextMenu.style.display = 'block';
    const menuRect = contextMenu.getBoundingClientRect();
    const menuWidth = menuRect.width || 200;
    const menuHeight = menuRect.height || 350;

    let x = e.clientX;
    let y = e.clientY;

    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 10;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 10;
    if (x < 0) x = 10;
    if (y < 0) y = 10;

    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
}

document.addEventListener('click', () => {
    if (contextMenu) contextMenu.style.display = 'none';
});

document.getElementById('ctxPreview')?.addEventListener('click', () => {
    if (selectedFilename) previewFile(selectedFilename);
});

document.getElementById('ctxDownload')?.addEventListener('click', () => {
    if (selectedFilename) downloadFile(selectedFilename);
});

document.getElementById('ctxRename')?.addEventListener('click', () => {
    if (selectedFilename) showRenameModal(selectedFilename);
});

document.getElementById('ctxDelete')?.addEventListener('click', () => {
    if (selectedFilename) showDeleteModal(selectedFilename);
});

document.getElementById('ctxProperties')?.addEventListener('click', () => {
    if (selectedFilename) showProperties(selectedFilename);
});

document.getElementById('ctxShare')?.addEventListener('click', () => {
    if (selectedFilename) showShareModal(selectedFilename);
});

document.getElementById('ctxAddTag')?.addEventListener('click', () => {
    if (selectedFilename) showTagModal(selectedFilename);
});

// ============================================================================
// SHARE MODAL
// ============================================================================
async function showShareModal(filename) {
    const modal = document.getElementById('shareModal');
    if (!modal) return;

    const file = allFiles.find(f => f.name === filename);
    const filePath = currentPath === '/' ? filename : `${currentPath.replace(/^\//, '')}/${filename}`;

    document.getElementById('shareFileName').textContent = filename;
    document.getElementById('sharePassword').value = '';
    document.getElementById('shareExpiry').value = '7';
    document.getElementById('shareMaxDownloads').value = '';
    document.getElementById('shareUploadOnly').checked = false;
    document.getElementById('shareResult').style.display = 'none';

    // Show upload only option only for folders
    document.getElementById('uploadOnlyOption').style.display = file?.isFolder ? 'block' : 'none';

    modal.classList.add('active');
}

window.closeShareModal = () => {
    document.getElementById('shareModal')?.classList.remove('active');
};

window.createShareLink = async () => {
    const password = document.getElementById('sharePassword').value;
    const expiryDays = parseInt(document.getElementById('shareExpiry').value) || 7;
    const maxDownloads = parseInt(document.getElementById('shareMaxDownloads').value) || null;
    const uploadOnly = document.getElementById('shareUploadOnly').checked;

    const filePath = currentPath === '/' ? selectedFilename : `${currentPath.replace(/^\//, '')}/${selectedFilename}`;

    try {
        const res = await fetch('/api/share', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                path: filePath,
                password: password || null,
                expiresIn: expiryDays * 24 * 60 * 60 * 1000,
                maxDownloads,
                uploadOnly
            })
        });

        if (res.ok) {
            const data = await res.json();
            document.getElementById('shareUrl').value = data.shareUrl;
            document.getElementById('shareResult').style.display = 'block';

            // Generate QR code
            const qrRes = await fetch(`/api/qr?url=${encodeURIComponent(data.shareUrl)}`);
            if (qrRes.ok) {
                const qrData = await qrRes.json();
                document.getElementById('shareQR').src = qrData.qr;
            }

            showToast('Paylaşım linki oluşturuldu', 'success');
        }
    } catch (e) {
        showToast('Link oluşturulamadı', 'error');
    }
};

window.copyShareLink = () => {
    const input = document.getElementById('shareUrl');
    input.select();
    navigator.clipboard.writeText(input.value);
    showToast('Link kopyalandı!', 'success');
};

// ============================================================================
// TAG MODAL
// ============================================================================
function showTagModal(filename) {
    const modal = document.getElementById('tagModal');
    if (!modal) return;

    const filePath = currentPath === '/' ? filename : `${currentPath.replace(/^\//, '')}/${filename}`;
    const existingTags = allTags[filePath] || [];

    document.getElementById('tagFileName').textContent = filename;
    document.getElementById('tagInput').value = '';

    const tagsContainer = document.getElementById('existingTags');
    tagsContainer.innerHTML = existingTags.map(t => `
        <span class="tag-item">
            ${t}
            <button onclick="removeTagFromFile('${filePath}', '${t}')">&times;</button>
        </span>
    `).join('');

    modal.classList.add('active');
}

window.closeTagModal = () => {
    document.getElementById('tagModal')?.classList.remove('active');
};

window.addTagToFile = async () => {
    const tag = document.getElementById('tagInput').value.trim();
    if (!tag) return;

    const filePath = currentPath === '/' ? selectedFilename : `${currentPath.replace(/^\//, '')}/${selectedFilename}`;
    await addTag(filePath, tag);
    showTagModal(selectedFilename); // Refresh
};

window.removeTagFromFile = async (filePath, tag) => {
    await removeTag(filePath, tag);
    showTagModal(selectedFilename); // Refresh
};

// ============================================================================
// PREVIEW MODAL
// ============================================================================
const previewModal = document.getElementById('previewModal');
const previewContainer = document.getElementById('previewContainer');
const previewTitle = document.getElementById('previewTitle');
const previewDownloadBtn = document.getElementById('previewDownloadBtn');

async function previewFile(filename) {
    const file = allFiles.find(f => f.name === filename);
    if (!file) return;

    // Folder navigation
    if (file.isFolder) {
        const newPath = currentPath === '/' ? '/' + file.name : currentPath + '/' + file.name;
        navigateToFolder(newPath);
        return;
    }

    if (previewTitle) previewTitle.textContent = file.name;

    // Build URL with parentPath
    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');
    const url = `/api/download/${encodeURIComponent(filename)}?parentPath=${encodeURIComponent(parentPath)}`;
    const fullUrl = `${window.location.origin}${url}`;

    // Video formats that browsers can't play natively
    const nonBrowserFormats = ['.mkv', '.avi', '.wmv', '.flv', '.m4v'];
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    const isNonBrowserVideo = file.type === 'video' && nonBrowserFormats.includes(ext);

    // Different previews based on type
    if (file.type === 'image') {
        previewContainer.innerHTML = `<img src="${url}" alt="${file.name}">`;
    } else if (file.type === 'video' && !isNonBrowserVideo) {
        // Browser-playable video (mp4, webm, ogg, mov)
        previewContainer.innerHTML = `<video src="${url}" controls autoplay></video>`;
    } else if (isNonBrowserVideo) {
        // Non-browser video - show copyable link for VLC
        previewContainer.innerHTML = `
            <div class="vlc-link-container">
                <div class="vlc-icon">
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" width="64" height="64">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                            d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                    </svg>
                </div>
                <p class="vlc-message">Bu format tarayıcıda oynatılamıyor. Aşağıdaki linki VLC veya başka bir oynatıcıda açabilirsiniz.</p>
                <div class="vlc-link-box">
                    <input type="text" id="vlcLinkInput" class="vlc-link-input" value="${fullUrl}" readonly>
                    <button class="vlc-copy-btn" onclick="copyVlcLink()">
                        <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                        </svg>
                        Kopyala
                    </button>
                </div>
                <p class="vlc-hint">💡 VLC'de: Media → Open Network Stream → Linki yapıştır</p>
            </div>
        `;
    } else if (file.type === 'audio') {
        previewContainer.innerHTML = `
            <div class="audio-preview">
                <div class="audio-icon">
                    ${getIconForType('audio')}
                </div>
                <div class="audio-name">${file.name}</div>
                <audio src="${url}" controls autoplay></audio>
            </div>
        `;
    } else if (file.type === 'pdf') {
        const inlineUrl = `${url}&inline=true`;
        previewContainer.innerHTML = `<iframe src="${inlineUrl}#toolbar=1" class="pdf-preview"></iframe>`;
    } else if (ext === '.rtf') {
        // RTF file preview with edit support
        try {
            const res = await fetch(`/api/preview/${encodeURIComponent(filename)}?parentPath=${encodeURIComponent(parentPath)}`, {
                headers: getAuthHeaders()
            });
            if (res.ok) {
                const data = await res.json();
                const plainText = stripRtf(data.content);
                renderEditablePreview(previewContainer, plainText, filename, parentPath, 'plaintext', data.content);
            }
        } catch (e) {
            downloadFile(filename);
            return;
        }
    } else if (['.txt', '.csv', '.log'].includes(ext) || file.type === 'code' || file.type === 'markdown') {
        // All text-based files: code, markdown, txt, csv, log
        try {
            const res = await fetch(`/api/preview/${encodeURIComponent(filename)}?parentPath=${encodeURIComponent(parentPath)}`, {
                headers: getAuthHeaders()
            });
            if (res.ok) {
                const data = await res.json();
                const codeExt = filename.split('.').pop().toLowerCase();
                const langMap = {
                    'js': 'javascript', 'ts': 'typescript', 'py': 'python',
                    'java': 'java', 'c': 'c', 'cpp': 'cpp', 'h': 'c',
                    'css': 'css', 'html': 'html', 'json': 'json',
                    'xml': 'xml', 'md': 'markdown', 'sql': 'sql',
                    'sh': 'bash', 'yml': 'yaml', 'yaml': 'yaml',
                    'txt': 'plaintext', 'csv': 'plaintext', 'log': 'plaintext'
                };
                const lang = langMap[codeExt] || 'plaintext';
                renderEditablePreview(previewContainer, data.content, filename, parentPath, lang, data.content);
            }
        } catch (e) {
            downloadFile(filename);
            return;
        }
    } else {
        downloadFile(filename);
        return;
    }

    if (previewDownloadBtn) previewDownloadBtn.onclick = () => downloadFile(filename);
    previewModal?.classList.add('active');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function stripRtf(rtf) {
    if (!rtf) return '';
    let text = rtf;

    // 1. Convert \par and \line to newlines FIRST (before stripping)
    text = text.replace(/\\par\s?/g, '\n');
    text = text.replace(/\\line\s?/g, '\n');
    text = text.replace(/\\tab\s?/g, '\t');

    // 2. Remove {\*\...} destination groups
    text = text.replace(/\{\\\*\\[^{}]+\}/g, '');

    // 3. Remove known header groups: fonttbl, colortbl, stylesheet, info, etc.
    let depth = 0;
    let result = '';
    let skipDepth = -1;
    const headerGroups = ['fonttbl', 'colortbl', 'stylesheet', 'info', 'generator', 'pict', 'object', 'datafield'];

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') {
            depth++;
            // Check if this group starts with a header keyword
            const ahead = text.substring(i + 1, i + 30);
            const headerMatch = ahead.match(/^\\([a-z]+)/);
            if (headerMatch && headerGroups.includes(headerMatch[1])) {
                skipDepth = depth;
            }
            continue;
        }
        if (ch === '}') {
            if (depth === skipDepth) skipDepth = -1;
            depth--;
            continue;
        }
        if (skipDepth > 0 && depth >= skipDepth) continue;

        // Handle control words
        if (ch === '\\') {
            const next = text[i + 1];
            if (!next) continue;
            // Escaped characters
            if (next === '\\') { result += '\\'; i++; continue; }
            if (next === '{') { result += '{'; i++; continue; }
            if (next === '}') { result += '}'; i++; continue; }
            if (next === '~') { result += '\u00A0'; i++; continue; } // non-breaking space
            if (next === '-') { result += '\u00AD'; i++; continue; } // soft hyphen
            if (next === '_') { result += '-'; i++; continue; } // non-breaking hyphen
            if (next === "'") {
                // Hex character like \'e9
                const hex = text.substring(i + 2, i + 4);
                const code = parseInt(hex, 16);
                if (!isNaN(code)) {
                    result += String.fromCharCode(code);
                    i += 3;
                    continue;
                }
            }
            // Skip control word (e.g., \fs24, \b, \i0)
            const ctrlMatch = text.substring(i).match(/^\\[a-z]+[-]?\d*\s?/i);
            if (ctrlMatch) {
                i += ctrlMatch[0].length - 1;
                continue;
            }
            // Unknown escape, skip
            i++;
            continue;
        }
        result += ch;
    }

    // Clean up
    result = result.replace(/\r\n/g, '\n');
    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
}

window.closePreviewModal = () => {
    // Save before closing if in edit mode
    if (_editorAutoSaveTimer) {
        clearTimeout(_editorAutoSaveTimer);
        _editorAutoSaveTimer = null;
    }
    const editor = document.getElementById('fileEditorContent');
    if (editor && editor.style.display !== 'none' && _editorCurrentFile) {
        saveFileContent(_editorCurrentFile.filename, _editorCurrentFile.parentPath, true);
    }
    _editorCurrentFile = null;
    previewModal?.classList.remove('active');
    if (previewContainer) previewContainer.innerHTML = '';
};

// ============================================================================
// UNIVERSAL FILE EDITOR
// ============================================================================
let _editorAutoSaveTimer = null;
let _editorCurrentFile = null;
let _editorOriginalContent = '';
let _editorIsSaving = false;

function renderEditablePreview(container, displayContent, filename, parentPath, lang, rawContent) {
    const isMarkdown = lang === 'markdown';
    const escapedFilename = escapeHtml(filename);

    _editorCurrentFile = { filename, parentPath };
    _editorOriginalContent = rawContent;

    // Build preview content
    let previewHtml;
    if (isMarkdown) {
        previewHtml = `<div class="markdown-preview" id="filePreviewContent">${marked.parse(displayContent)}</div>`;
    } else {
        previewHtml = `<pre id="filePreviewContent"><code class="language-${lang}">${escapeHtml(displayContent)}</code></pre>`;
    }

    container.innerHTML = `
        <div class="file-editor-wrapper">
            <div class="file-editor-toolbar">
                <button class="btn-sm btn-secondary" id="fileEditBtn" onclick="toggleFileEdit()">
                    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                    </svg>
                    Düzenle
                </button>
                <span class="editor-save-status" id="editorSaveStatus"></span>
            </div>
            ${previewHtml}
            <textarea class="file-editor-textarea" id="fileEditorContent" style="display: none;">${escapeHtml(rawContent)}</textarea>
        </div>`;

    // Apply syntax highlighting
    if (!isMarkdown && window.hljs) {
        container.querySelectorAll('pre code').forEach(block => {
            hljs.highlightElement(block);
        });
    }
}

window.toggleFileEdit = () => {
    const preview = document.getElementById('filePreviewContent');
    const editor = document.getElementById('fileEditorContent');
    const editBtn = document.getElementById('fileEditBtn');

    if (!editor) return;

    if (editor.style.display === 'none') {
        // Switch to edit mode
        if (preview) preview.style.display = 'none';
        editor.style.display = 'block';
        editBtn.innerHTML = `<svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
        </svg> Önizle`;
        editor.focus();

        // Setup auto-save on input
        editor.addEventListener('input', handleEditorInput);

        // Tab key support for indentation
        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = editor.selectionStart;
                const end = editor.selectionEnd;
                editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
                editor.selectionStart = editor.selectionEnd = start + 4;
                handleEditorInput();
            }
            // Ctrl+S / Cmd+S manual save
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (_editorAutoSaveTimer) clearTimeout(_editorAutoSaveTimer);
                if (_editorCurrentFile) {
                    saveFileContent(_editorCurrentFile.filename, _editorCurrentFile.parentPath);
                }
            }
        });
    } else {
        // Switch to preview mode - save first
        if (_editorCurrentFile) {
            saveFileContent(_editorCurrentFile.filename, _editorCurrentFile.parentPath);
        }
        const content = editor.value;
        if (preview) {
            // Re-render preview
            const isMarkdown = _editorCurrentFile?.filename?.endsWith('.md');
            if (isMarkdown) {
                preview.innerHTML = marked.parse(content);
            } else {
                const codeExt = _editorCurrentFile?.filename?.split('.').pop().toLowerCase() || 'plaintext';
                const langMap = {
                    'js': 'javascript', 'ts': 'typescript', 'py': 'python',
                    'java': 'java', 'c': 'c', 'cpp': 'cpp', 'h': 'c',
                    'css': 'css', 'html': 'html', 'json': 'json',
                    'xml': 'xml', 'sql': 'sql', 'sh': 'bash',
                    'yml': 'yaml', 'yaml': 'yaml'
                };
                const lang = langMap[codeExt] || 'plaintext';
                preview.innerHTML = `<code class="language-${lang}">${escapeHtml(content)}</code>`;
                if (window.hljs) {
                    preview.querySelectorAll('code').forEach(block => hljs.highlightElement(block));
                }
            }
            preview.style.display = '';
        }
        editor.style.display = 'none';
        editBtn.innerHTML = `<svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
        </svg> Düzenle`;
    }
};

function handleEditorInput() {
    // Debounced auto-save: save 1.5s after user stops typing
    if (_editorAutoSaveTimer) clearTimeout(_editorAutoSaveTimer);

    const status = document.getElementById('editorSaveStatus');
    if (status) {
        status.textContent = 'Kaydedilmemiş değişiklikler...';
        status.className = 'editor-save-status unsaved';
    }

    _editorAutoSaveTimer = setTimeout(() => {
        if (_editorCurrentFile) {
            saveFileContent(_editorCurrentFile.filename, _editorCurrentFile.parentPath);
        }
    }, 1500);
}

async function saveFileContent(filename, parentPath, silent = false) {
    if (_editorIsSaving) return;
    const editor = document.getElementById('fileEditorContent');
    if (!editor) return;

    const content = editor.value;
    _editorIsSaving = true;

    const status = document.getElementById('editorSaveStatus');
    if (status) {
        status.textContent = 'Kaydediliyor...';
        status.className = 'editor-save-status saving';
    }

    try {
        const res = await fetch(`/api/preview/${encodeURIComponent(filename)}?parentPath=${encodeURIComponent(parentPath)}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ content })
        });

        if (res.ok) {
            _editorOriginalContent = content;
            if (status) {
                status.textContent = 'Kaydedildi';
                status.className = 'editor-save-status saved';
                setTimeout(() => {
                    if (status.textContent === 'Kaydedildi') {
                        status.textContent = '';
                    }
                }, 2000);
            }
            if (!silent) {
                // Don't show toast for auto-saves to avoid spam
            }
        } else {
            const data = await res.json();
            if (status) {
                status.textContent = 'Kaydetme hatası!';
                status.className = 'editor-save-status error';
            }
            if (!silent) showToast(data.error || 'Kaydetme başarısız', 'error');
        }
    } catch (e) {
        if (status) {
            status.textContent = 'Kaydetme hatası!';
            status.className = 'editor-save-status error';
        }
    }
    _editorIsSaving = false;
}

// Copy VLC link function
window.copyVlcLink = () => {
    const input = document.getElementById('vlcLinkInput');
    if (input) {
        input.select();
        navigator.clipboard.writeText(input.value).then(() => {
            showToast('Link kopyalandı!', 'success');
        }).catch(() => {
            // Fallback for older browsers
            document.execCommand('copy');
            showToast('Link kopyalandı!', 'success');
        });
    }
};

previewModal?.addEventListener('click', (e) => {
    if (e.target === previewModal) closePreviewModal();
});

// ============================================================================
// RENAME MODAL
// ============================================================================
const renameModal = document.getElementById('renameModal');
const renameInput = document.getElementById('renameInput');
let fileToRename = null;

function showRenameModal(filename) {
    fileToRename = filename;
    if (renameInput) {
        renameInput.value = filename;
        setTimeout(() => {
            const dotIndex = filename.lastIndexOf('.');
            renameInput.focus();
            if (dotIndex > 0) {
                renameInput.setSelectionRange(0, dotIndex);
            } else {
                renameInput.select();
            }
        }, 100);
    }
    renameModal?.classList.add('active');
}

window.closeRenameModal = () => {
    renameModal?.classList.remove('active');
    fileToRename = null;
};

window.confirmRename = () => {
    const newName = renameInput?.value.trim();
    if (!newName || newName === fileToRename) {
        closeRenameModal();
        return;
    }

    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');

    fetch(`/api/files/${encodeURIComponent(fileToRename)}?parentPath=${encodeURIComponent(parentPath)}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ newName })
    })
        .then(res => {
            if (res.ok) {
                showToast('Dosya yeniden adlandırıldı', 'success');
                const file = allFiles.find(f => f.name === fileToRename);
                if (file) {
                    file.name = newName;
                    applyFilterAndRender();
                }
            } else {
                return res.json().then(data => {
                    throw new Error(data.error || 'Yeniden adlandırma başarısız');
                });
            }
        })
        .catch(err => showToast(err.message, 'error'))
        .finally(() => closeRenameModal());
};

renameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmRename();
    if (e.key === 'Escape') closeRenameModal();
});

renameModal?.addEventListener('click', (e) => {
    if (e.target === renameModal) closeRenameModal();
});

// ============================================================================
// DELETE MODAL
// ============================================================================
const deleteModal = document.getElementById('deleteModal');
const deleteMessage = document.getElementById('deleteMessage');
let fileToDelete = null;
let bulkDeleteMode = false;

function showDeleteModal(filename) {
    fileToDelete = filename;
    bulkDeleteMode = false;
    if (deleteMessage) {
        deleteMessage.textContent = `"${filename}" çöp kutusuna taşınacak.`;
    }
    deleteModal?.classList.add('active');
}

function showBulkDeleteModal() {
    bulkDeleteMode = true;
    fileToDelete = null;
    if (deleteMessage) {
        deleteMessage.textContent = `${selectedFiles.size} öğe çöp kutusuna taşınacak.`;
    }
    deleteModal?.classList.add('active');
}

window.closeDeleteModal = () => {
    deleteModal?.classList.remove('active');
    fileToDelete = null;
    bulkDeleteMode = false;
};

window.confirmDelete = async () => {
    if (bulkDeleteMode) {
        // Bulk delete
        const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');

        for (const name of selectedFiles) {
            await fetch(`/api/files/${encodeURIComponent(name)}?parentPath=${encodeURIComponent(parentPath)}`, {
                method: 'DELETE',
                headers: getAuthHeaders()
            });
        }
        selectedFiles.clear();
        updateBulkActions();
        fetchContents();
        showToast('Dosyalar çöp kutusuna taşındı', 'success');
        closeDeleteModal();
        return;
    }

    // Single file delete
    if (!fileToDelete) return;

    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');
    const url = `/api/files/${encodeURIComponent(fileToDelete)}?parentPath=${encodeURIComponent(parentPath)}`;

    fetch(url, {
        method: 'DELETE',
        headers: getAuthHeaders()
    })
        .then(res => {
            if (res.ok) {
                showToast('Dosya çöp kutusuna taşındı', 'success');
                fetchContents();
            } else {
                showToast('Silme başarısız', 'error');
            }
        })
        .catch(() => showToast('Dosya silinirken hata oluştu', 'error'))
        .finally(() => closeDeleteModal());
};

deleteModal?.addEventListener('click', (e) => {
    if (e.target === deleteModal) closeDeleteModal();
});

// ============================================================================
// DOWNLOAD
// ============================================================================
function downloadFile(name) {
    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');
    const link = document.createElement('a');
    link.href = `/api/download/${encodeURIComponent(name)}?parentPath=${encodeURIComponent(parentPath)}`;
    link.download = '';
    link.click();
}

// ============================================================================
// PROPERTIES MODAL
// ============================================================================
const propertiesModal = document.getElementById('propertiesModal');

function showProperties(filename) {
    const file = allFiles.find(f => f.name === filename);
    if (!file) return;

    document.getElementById('propName').textContent = file.name;
    document.getElementById('propType').textContent = (file.type || 'other').charAt(0).toUpperCase() + (file.type || 'other').slice(1);
    document.getElementById('propSize').textContent = formatSize(file.size);

    const date = new Date(file.date);
    document.getElementById('propDate').textContent = date.toLocaleDateString('tr-TR') + ' ' + date.toLocaleTimeString('tr-TR');

    // Show additional info if available
    const propDownloads = document.getElementById('propDownloads');
    if (propDownloads) {
        propDownloads.textContent = file.downloadCount || 0;
    }

    contextMenu.style.display = 'none';
    propertiesModal?.classList.add('active');

    // Load checksum
    if (!file.isFolder) {
        const propChecksum = document.getElementById('propChecksum');
        if (propChecksum) propChecksum.textContent = 'Hesaplaniyor...';
        showChecksum(filename);
    }
}

window.closePropertiesModal = () => {
    propertiesModal?.classList.remove('active');
};

propertiesModal?.addEventListener('click', (e) => {
    if (e.target === propertiesModal) closePropertiesModal();
});

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Delete
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedFiles.size === 1) {
                showDeleteModal([...selectedFiles][0]);
            } else if (selectedFiles.size > 1) {
                bulkDelete();
            }
        }

        // Select all
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            allFiles.forEach(f => selectedFiles.add(f.name));
            document.querySelectorAll('.file-card').forEach(c => c.classList.add('selected'));
            updateBulkActions();
        }

        // View toggle
        if (e.key === 'v' || e.key === 'V') {
            viewToggleBtn?.click();
        }

        // Search focus
        if (e.key === '/') {
            e.preventDefault();
            searchInput?.focus();
        }

        // Escape
        if (e.key === 'Escape') {
            selectedFiles.clear();
            document.querySelectorAll('.file-card').forEach(c => c.classList.remove('selected'));
            updateBulkActions();
            closePreviewModal();
            closePropertiesModal();
            closeRenameModal();
            closeDeleteModal();
            closeShareModal();
            closeTagModal();
            closeTrashModal();
            closeCreateFileModal();
            closeAdminModal();
        }

        // Enter - preview
        if (e.key === 'Enter' && selectedFiles.size === 1) {
            previewFile([...selectedFiles][0]);
        }
    });
}

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================
function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast';

    const iconSvg = type === 'success'
        ? `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`
        : type === 'error'
            ? `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`
            : '';

    toast.innerHTML = `<span class="toast-icon ${type}">${iconSvg}</span><span>${msg}</span>`;
    toastContainer?.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ============================================================================
// FOLDER NAVIGATION
// ============================================================================
window.navigateToFolder = (path) => {
    currentPath = path;
    selectedFiles.clear();
    fetchContents();
};

function updateBreadcrumbs() {
    if (!breadcrumbNav) return;

    const existingItems = breadcrumbNav.querySelectorAll('.breadcrumb-item:not(.home)');
    existingItems.forEach(item => item.remove());

    const separators = breadcrumbNav.querySelectorAll('.breadcrumb-separator');
    separators.forEach(sep => sep.remove());

    if (currentPath === '/') {
        if (sectionTitle) sectionTitle.innerHTML = `Tüm Dosyalar <span class="file-count" id="fileCount">0</span>`;
        return;
    }

    const parts = currentPath.replace(/^\//, '').split('/').filter(p => p);
    let accumulatedPath = '';

    parts.forEach((part, index) => {
        accumulatedPath += '/' + part;
        const pathForClick = accumulatedPath;

        const separator = document.createElement('span');
        separator.className = 'breadcrumb-separator';
        separator.innerHTML = `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`;
        breadcrumbNav.appendChild(separator);

        const item = document.createElement('div');
        item.className = 'breadcrumb-item';
        item.textContent = part;
        item.onclick = () => navigateToFolder(pathForClick);
        breadcrumbNav.appendChild(item);
    });

    const folderName = parts[parts.length - 1] || 'Tüm Dosyalar';
    if (sectionTitle) sectionTitle.innerHTML = `${folderName} <span class="file-count" id="fileCount">0</span>`;
}

// ============================================================================
// GRID CONTEXT MENU
// ============================================================================
function setupGridContextMenu() {
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    mainContent.addEventListener('contextmenu', (e) => {
        const isOnFileCard = e.target.closest('.file-card');
        if (isOnFileCard) return;

        const isInContentArea = e.target.closest('.content-area') || e.target.closest('.file-grid');
        if (!isInContentArea) return;

        e.preventDefault();
        contextMenu.style.display = 'none';

        gridContextMenu.style.display = 'block';
        const menuRect = gridContextMenu.getBoundingClientRect();
        const menuWidth = menuRect.width || 180;
        const menuHeight = menuRect.height || 250;

        let x = e.clientX;
        let y = e.clientY;

        if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 10;
        if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 10;
        if (x < 0) x = 10;
        if (y < 0) y = 10;

        gridContextMenu.style.left = `${x}px`;
        gridContextMenu.style.top = `${y}px`;
    });

    document.addEventListener('click', () => {
        gridContextMenu.style.display = 'none';
    });

    document.getElementById('ctxCreateFolder')?.addEventListener('click', showCreateFolderModal);
    document.getElementById('ctxCreateTxt')?.addEventListener('click', () => showCreateFileModal('.txt'));
    document.getElementById('ctxCreateMd')?.addEventListener('click', () => showCreateFileModal('.md'));
    document.getElementById('ctxCreateJson')?.addEventListener('click', () => showCreateFileModal('.json'));
    document.getElementById('ctxCreateHtml')?.addEventListener('click', () => showCreateFileModal('.html'));
}

// ============================================================================
// CREATE FOLDER MODAL
// ============================================================================
const createFolderModal = document.getElementById('createFolderModal');
const folderNameInput = document.getElementById('folderNameInput');

function showCreateFolderModal() {
    if (folderNameInput) folderNameInput.value = '';
    createFolderModal?.classList.add('active');
    setTimeout(() => folderNameInput?.focus(), 100);
}

window.closeCreateFolderModal = () => {
    createFolderModal?.classList.remove('active');
};

window.confirmCreateFolder = () => {
    const name = folderNameInput?.value.trim();
    if (!name) {
        showToast('Klasör adı gerekli', 'error');
        return;
    }

    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');

    fetch('/folders', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name, parentPath })
    })
        .then(res => {
            if (res.ok) {
                closeCreateFolderModal();
            } else {
                return res.json().then(data => {
                    throw new Error(data.error || 'Klasör oluşturulamadı');
                });
            }
        })
        .catch(err => showToast(err.message, 'error'));
};

folderNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmCreateFolder();
    if (e.key === 'Escape') closeCreateFolderModal();
});

createFolderModal?.addEventListener('click', (e) => {
    if (e.target === createFolderModal) closeCreateFolderModal();
});

// ============================================================================
// CREATE FILE MODAL
// ============================================================================
const createFileModal = document.getElementById('createFileModal');
const fileNameInput = document.getElementById('fileNameInput');
let createFileExtension = '.txt';

function showCreateFileModal(ext) {
    createFileExtension = ext;
    const title = document.getElementById('createFileTitle');
    if (title) title.textContent = `Yeni ${ext} Dosyası`;
    if (fileNameInput) {
        fileNameInput.value = `yeni-dosya${ext}`;
        fileNameInput.placeholder = `Dosya adı${ext}`;
    }
    createFileModal?.classList.add('active');
    setTimeout(() => {
        fileNameInput?.focus();
        if (fileNameInput) {
            const dotIndex = fileNameInput.value.lastIndexOf('.');
            if (dotIndex > 0) {
                fileNameInput.setSelectionRange(0, dotIndex);
            }
        }
    }, 100);
}

window.closeCreateFileModal = () => {
    createFileModal?.classList.remove('active');
};

window.confirmCreateFile = () => {
    let name = fileNameInput?.value.trim();
    if (!name) {
        showToast('Dosya adı gerekli', 'error');
        return;
    }

    // Add extension if not present
    if (!name.includes('.')) {
        name += createFileExtension;
    }

    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');

    fetch('/api/files/create', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name, parentPath })
    })
        .then(res => {
            if (res.ok) {
                closeCreateFileModal();
            } else {
                return res.json().then(data => {
                    throw new Error(data.error || 'Dosya oluşturulamadı');
                });
            }
        })
        .catch(err => showToast(err.message, 'error'));
};

fileNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmCreateFile();
    if (e.key === 'Escape') closeCreateFileModal();
});

createFileModal?.addEventListener('click', (e) => {
    if (e.target === createFileModal) closeCreateFileModal();
});

// ============================================================================
// TRASH MODAL
// ============================================================================
window.showTrashModal = async () => {
    const modal = document.getElementById('trashModal');
    if (!modal) return;

    try {
        const res = await fetch('/api/trash', { headers: getAuthHeaders() });
        if (res.ok) {
            const items = await res.json();
            const list = document.getElementById('trashList');

            if (items.length === 0) {
                list.innerHTML = '<div class="empty-state"><p>Çöp kutusu boş</p></div>';
            } else {
                list.innerHTML = items.map(item => `
                    <div class="trash-item">
                        <div class="trash-item-info">
                            <span class="trash-item-name">${item.originalName}</span>
                            <span class="trash-item-meta">${formatSize(item.size)} • ${formatDate(item.deletedAt)}</span>
                        </div>
                        <div class="trash-item-actions">
                            <button class="btn-sm btn-primary" onclick="restoreFromTrash('${item.id}')">Geri Yükle</button>
                            <button class="btn-sm btn-danger" onclick="deleteFromTrash('${item.id}')">Sil</button>
                        </div>
                    </div>
                `).join('');
            }
        }
    } catch (e) {
        showToast('Çöp kutusu yüklenemedi', 'error');
    }

    modal.classList.add('active');
};

window.closeTrashModal = () => {
    document.getElementById('trashModal')?.classList.remove('active');
};

window.restoreFromTrash = async (id) => {
    try {
        const res = await fetch(`/api/trash/${id}/restore`, {
            method: 'POST',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            showToast('Dosya geri yüklendi', 'success');
            showTrashModal();
            fetchContents();
        }
    } catch (e) {
        showToast('Geri yükleme başarısız', 'error');
    }
};

window.deleteFromTrash = async (id) => {
    if (!confirm('Bu dosya kalıcı olarak silinecek. Emin misiniz?')) return;

    try {
        const res = await fetch(`/api/trash/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            showToast('Dosya kalıcı olarak silindi', 'success');
            showTrashModal();
        }
    } catch (e) {
        showToast('Silme başarısız', 'error');
    }
};

window.emptyTrash = async () => {
    if (!confirm('Çöp kutusundaki tüm dosyalar kalıcı olarak silinecek. Emin misiniz?')) return;

    try {
        const res = await fetch('/api/trash', {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            showToast('Çöp kutusu boşaltıldı', 'success');
            showTrashModal();
        }
    } catch (e) {
        showToast('İşlem başarısız', 'error');
    }
};

// ============================================================================
// ADMIN MODAL
// ============================================================================
window.showAdminModal = async () => {
    const modal = document.getElementById('adminModal');
    if (!modal) {
        showToast('Admin modal bulunamadı', 'error');
        return;
    }

    // Show modal first with loading state
    modal.classList.add('active');

    // Set loading placeholders
    const loadingText = '...';
    document.getElementById('statTotalFiles').textContent = loadingText;
    document.getElementById('statTotalFolders').textContent = loadingText;
    document.getElementById('statTotalSize').textContent = loadingText;
    document.getElementById('statTrashSize').textContent = loadingText;
    document.getElementById('statActiveShares').textContent = loadingText;
    document.getElementById('statTodayActivity').textContent = loadingText;
    document.getElementById('statCpuCores').textContent = loadingText;
    document.getElementById('statMemoryUsage').textContent = loadingText;
    document.getElementById('statPlatform').textContent = loadingText;
    document.getElementById('statUptime').textContent = loadingText;

    try {
        const res = await fetch('/api/admin/stats', { headers: getAuthHeaders() });
        if (res.ok) {
            const stats = await res.json();

            document.getElementById('statTotalFiles').textContent = stats.files?.total ?? 0;
            document.getElementById('statTotalFolders').textContent = stats.files?.folders ?? 0;
            document.getElementById('statTotalSize').textContent = formatSize(stats.files?.totalSize ?? 0);
            document.getElementById('statTrashSize').textContent = formatSize(stats.files?.trashSize ?? 0);
            document.getElementById('statActiveShares').textContent = stats.shares ?? 0;
            document.getElementById('statTodayActivity').textContent = stats.activity?.today ?? 0;
            document.getElementById('statCpuCores').textContent = stats.system?.cpuCount ?? '-';
            document.getElementById('statMemoryUsage').textContent = (stats.system?.usedMemoryPercent ?? 0) + '%';
            document.getElementById('statPlatform').textContent = `${stats.system?.platform ?? '-'} (${stats.system?.arch ?? '-'})`;
            document.getElementById('statUptime').textContent = formatUptime(stats.system?.uptime ?? 0);
        } else {
            const err = await res.json().catch(() => ({}));
            showToast(err.error || 'İstatistikler yüklenemedi', 'error');
        }
    } catch (e) {
        console.error('Admin stats error:', e);
        showToast('Sunucuya bağlanılamadı', 'error');
    }
};

window.closeAdminModal = () => {
    document.getElementById('adminModal')?.classList.remove('active');
};

window.refreshAdminStats = () => {
    showAdminModal();
};

window.showAdminTab = async (tab) => {
    // Update tab buttons
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.admin-tab[data-tab="${tab}"]`)?.classList.add('active');

    // Hide all tab contents
    document.querySelectorAll('.admin-tab-content').forEach(c => c.style.display = 'none');

    // Show selected tab content
    if (tab === 'stats') {
        document.getElementById('adminStatsTab').style.display = 'block';
    } else if (tab === 'activity') {
        document.getElementById('adminActivityTab').style.display = 'block';
        await loadActivityLog();
    } else if (tab === 'settings') {
        document.getElementById('adminSettingsTab').style.display = 'block';
        await loadAdminSettings();
    }
};

async function loadActivityLog() {
    const list = document.getElementById('activityList');
    list.innerHTML = '<p class="text-muted">Yükleniyor...</p>';

    try {
        const res = await fetch('/api/admin/activity', { headers: getAuthHeaders() });
        if (res.ok) {
            const activities = await res.json();
            if (activities.length === 0) {
                list.innerHTML = '<p class="text-muted">Henüz aktivite yok</p>';
            } else {
                list.innerHTML = activities.slice(0, 50).map(a => `
                    <div class="activity-item">
                        <span class="activity-type">${getActivityIcon(a.action || a.type)}</span>
                        <div class="activity-info">
                            <span class="activity-message">${a.details || a.message}</span>
                            <span class="activity-meta">${a.ip || '-'} • ${a.user || '-'} • ${formatDate(a.timestamp)}</span>
                        </div>
                    </div>
                `).join('');
            }
        }
    } catch (e) {
        list.innerHTML = '<p class="text-muted">Yüklenemedi</p>';
    }
}

function getActivityIcon(type) {
    const icons = {
        'upload': '📤',
        'download': '📥',
        'delete': '🗑️',
        'rename': '✏️',
        'move': '📁',
        'share': '🔗',
        'share_download': '⬇️',
        'login': '🔐',
        'blocked': '🚫'
    };
    return icons[type] || '📋';
}

async function loadAdminSettings() {
    try {
        const res = await fetch('/api/admin/settings', { headers: getAuthHeaders() });
        if (res.ok) {
            const s = await res.json();
            document.getElementById('settingAuthEnabled').checked = s.authEnabled || false;
        }
    } catch (e) { }
}

window.updateSetting = async (key, value) => {
    try {
        await fetch('/api/admin/settings', {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({ [key]: value })
        });
        showToast('Ayar güncellendi', 'success');

        if (key === 'authEnabled' && value) {
            showToast('Kimlik doğrulama aktif edildi. Sayfayı yenileyince giriş yapmanız gerekecek.', 'info');
        }
    } catch (e) {
        showToast('Ayar güncellenemedi', 'error');
    }
};

window.changeAdminPassword = async () => {
    const password = document.getElementById('newAdminPassword').value;
    if (!password || password.length < 4) {
        showToast('Şifre en az 4 karakter olmalı', 'error');
        return;
    }

    try {
        const res = await fetch('/api/admin/change-password', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ password })
        });

        if (res.ok) {
            showToast('Şifre değiştirildi', 'success');
            document.getElementById('newAdminPassword').value = '';
        } else {
            const err = await res.json();
            showToast(err.error || 'Şifre değiştirilemedi', 'error');
        }
    } catch (e) {
        showToast('Bağlantı hatası', 'error');
    }
};

window.clearActivityLog = async () => {
    if (!confirm('Tüm aktivite logları silinecek. Emin misiniz?')) return;

    try {
        await fetch('/api/admin/activity', {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        showToast('Aktivite logları temizlendi', 'success');
        loadActivityLog();
    } catch (e) {
        showToast('İşlem başarısız', 'error');
    }
};

window.cleanupExpiredShares = async () => {
    try {
        const res = await fetch('/api/admin/cleanup-shares', {
            method: 'POST',
            headers: getAuthHeaders()
        });
        const data = await res.json();
        showToast(`${data.cleaned || 0} süresi dolmuş paylaşım temizlendi`, 'success');
        showAdminModal(); // Refresh stats
    } catch (e) {
        showToast('İşlem başarısız', 'error');
    }
};

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}g ${hours}sa`;
    if (hours > 0) return `${hours}sa ${mins}dk`;
    return `${mins}dk`;
}

// ============================================================================
// ADVANCED SEARCH
// ============================================================================
function setupAdvancedSearch() {
    const advSearchBtn = document.getElementById('advancedSearchBtn');
    advSearchBtn?.addEventListener('click', showAdvancedSearchModal);
}

window.showAdvancedSearchModal = () => {
    document.getElementById('advancedSearchModal')?.classList.add('active');
};

window.closeAdvancedSearchModal = () => {
    document.getElementById('advancedSearchModal')?.classList.remove('active');
};

window.performAdvancedSearch = async () => {
    const q = document.getElementById('advSearchQuery')?.value || '';
    const type = document.getElementById('advSearchType')?.value || '';
    const minSize = document.getElementById('advSearchMinSize')?.value || '';
    const maxSize = document.getElementById('advSearchMaxSize')?.value || '';
    const startDate = document.getElementById('advSearchStartDate')?.value || '';
    const endDate = document.getElementById('advSearchEndDate')?.value || '';

    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (type) params.append('type', type);
    if (minSize) params.append('minSize', parseInt(minSize) * 1024 * 1024);
    if (maxSize) params.append('maxSize', parseInt(maxSize) * 1024 * 1024);
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);

    try {
        const res = await fetch(`/api/search?${params}`, { headers: getAuthHeaders() });
        if (res.ok) {
            const results = await res.json();
            allFiles = results;
            if (sectionTitle) sectionTitle.innerHTML = `Arama Sonuçları <span class="file-count" id="fileCount">${results.length}</span>`;
            applyFilterAndRender();
            closeAdvancedSearchModal();
        }
    } catch (e) {
        showToast('Arama başarısız', 'error');
    }
};

// ============================================================================
// DRAG & DROP HANDLERS
// ============================================================================
function handleDragStart(e) {
    const card = e.target.closest('.file-card');
    const name = card?.getAttribute('data-name');
    if (name) {
        e.dataTransfer.setData('text/plain', name);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
    }
}

function handleDragEnd(e) {
    const card = e.target.closest('.file-card');
    card?.classList.remove('dragging');
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const card = e.target.closest('.file-card');
    if (card?.getAttribute('data-isfolder') === 'true') {
        card.classList.add('drop-target');
    }
    return false;
}

function handleDragLeave(e) {
    const card = e.target.closest('.file-card');
    card?.classList.remove('drop-target');
}

function handleDrop(e) {
    e.stopPropagation();
    e.preventDefault();

    const destCard = e.target.closest('.file-card');
    destCard?.classList.remove('drop-target');

    const sourceName = e.dataTransfer.getData('text/plain');
    if (!sourceName || !destCard) return;

    const destName = destCard.getAttribute('data-name');

    document.querySelectorAll('.file-card').forEach(c => c.classList.remove('dragging'));

    if (sourceName === destName) return;
    if (destCard.getAttribute('data-isfolder') !== 'true') return;

    const parent = currentPath === '/' ? '' : currentPath;
    const sourcePath = parent + '/' + sourceName;
    const destinationPath = parent + '/' + destName;

    fetch('/move', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ source: sourcePath, destination: destinationPath })
    })
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                showToast(data.error, 'error');
            } else {
                showToast('Dosya taşındı', 'success');
                allFiles = allFiles.filter(f => f.name !== sourceName);
                document.getElementById('fileCount').textContent = allFiles.length;
                document.querySelector(`.file-card[data-name="${sourceName}"]`)?.remove();
            }
        })
        .catch(() => showToast('Taşıma işlemi başarısız', 'error'));

    return false;
}

// ============================================================================
// LASSO SELECTION
// ============================================================================
let isSelecting = false;
let selectionBox = null;
let selectionStart = { x: 0, y: 0 };
let previouslySelectedFiles = new Set();

function initLassoSelection() {
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    mainContent.addEventListener('mousedown', handleSelectionStart);
    document.addEventListener('mousemove', handleSelectionMove);
    document.addEventListener('mouseup', handleSelectionEnd);
}

function handleSelectionStart(e) {
    if (e.button !== 0) return;

    const isInteractive = e.target.closest('.file-card, .upload-btn, .icon-btn, .sort-btn, .search-bar, .nav-item, .theme-switch, button, input, a, .modal-overlay');
    if (isInteractive) return;

    if (e.ctrlKey || e.metaKey) {
        previouslySelectedFiles = new Set(selectedFiles);
    } else {
        previouslySelectedFiles.clear();
        selectedFiles.clear();
        document.querySelectorAll('.file-card').forEach(c => c.classList.remove('selected'));
    }

    isSelecting = true;
    selectionStart = { x: e.pageX, y: e.pageY };

    selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    selectionBox.style.left = e.pageX + 'px';
    selectionBox.style.top = e.pageY + 'px';
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    document.body.appendChild(selectionBox);
    document.body.classList.add('selecting');

    e.preventDefault();
}

function handleSelectionMove(e) {
    if (!isSelecting || !selectionBox) return;

    const currentX = e.pageX;
    const currentY = e.pageY;

    const left = Math.min(selectionStart.x, currentX);
    const top = Math.min(selectionStart.y, currentY);
    const width = Math.abs(currentX - selectionStart.x);
    const height = Math.abs(currentY - selectionStart.y);

    selectionBox.style.left = left + 'px';
    selectionBox.style.top = top + 'px';
    selectionBox.style.width = width + 'px';
    selectionBox.style.height = height + 'px';

    const boxRect = { left, top, right: left + width, bottom: top + height };

    document.querySelectorAll('.file-card').forEach(card => {
        const cardRect = card.getBoundingClientRect();
        const cardPageRect = {
            left: cardRect.left + window.scrollX,
            top: cardRect.top + window.scrollY,
            right: cardRect.right + window.scrollX,
            bottom: cardRect.bottom + window.scrollY
        };

        const intersects = !(
            boxRect.right < cardPageRect.left ||
            boxRect.left > cardPageRect.right ||
            boxRect.bottom < cardPageRect.top ||
            boxRect.top > cardPageRect.bottom
        );

        const filename = card.getAttribute('data-filename');

        if (intersects) {
            selectedFiles.add(filename);
            card.classList.add('selected');
        } else if (!previouslySelectedFiles.has(filename)) {
            selectedFiles.delete(filename);
            card.classList.remove('selected');
        }
    });

    updateBulkActions();
}

function handleSelectionEnd() {
    if (!isSelecting) return;

    isSelecting = false;
    document.body.classList.remove('selecting');

    if (selectionBox) {
        selectionBox.remove();
        selectionBox = null;
    }

    previouslySelectedFiles.clear();
}

document.addEventListener('DOMContentLoaded', initLassoSelection);

// ============================================================================
// i18n - INTERNATIONALIZATION SYSTEM
// ============================================================================
let currentLang = localStorage.getItem('blackdrop-lang') || 'en';
let i18nStrings = {};

async function loadLanguage(lang) {
    try {
        const res = await fetch(`/lang/${lang}.json`);
        if (res.ok) {
            i18nStrings = await res.json();
            currentLang = lang;
            localStorage.setItem('blackdrop-lang', lang);
            applyTranslations();
            // Sync the language selector
            const langSelect = document.getElementById('languageSelect');
            if (langSelect) langSelect.value = lang;
        }
    } catch (e) {
        console.error('Language load error:', e);
    }
}

function t(key) {
    return i18nStrings[key] || key;
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (i18nStrings[key]) {
            if (el.tagName === 'INPUT' && el.hasAttribute('placeholder')) {
                el.placeholder = i18nStrings[key];
            } else if (el.tagName === 'OPTION') {
                el.textContent = i18nStrings[key];
            } else if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SPAN' || el.tagName === 'LABEL' || el.tagName === 'H2' || el.tagName === 'H3' || el.tagName === 'P' || el.tagName === 'DIV') {
                el.textContent = i18nStrings[key];
            } else {
                el.textContent = i18nStrings[key];
            }
        }
    });
}

window.switchLanguage = (lang) => {
    loadLanguage(lang);
};

// Load language on startup
loadLanguage(currentLang);

// ============================================================================
// CLIPBOARD PASTE UPLOAD
// ============================================================================
document.addEventListener('paste', async (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            const blob = item.getAsFile();
            if (!blob) continue;

            const reader = new FileReader();
            reader.onload = async () => {
                const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');
                try {
                    const res = await fetch('/api/upload/paste', {
                        method: 'POST',
                        headers: getAuthHeaders(),
                        body: JSON.stringify({
                            data: reader.result,
                            parentPath
                        })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        showToast(`Panodan yapistirildi: ${data.filename}`, 'success');
                    } else {
                        showToast('Yapistirma basarisiz', 'error');
                    }
                } catch (err) {
                    showToast('Yapistirma hatasi', 'error');
                }
            };
            reader.readAsDataURL(blob);
        }
    }
});

// ============================================================================
// NOTIFICATION SYSTEM
// ============================================================================
let notificationCount = 0;

// Notifications disabled
// socket.on('notification:new', ...);

function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    if (badge) {
        badge.textContent = notificationCount;
        badge.style.display = notificationCount > 0 ? 'flex' : 'none';
    }
}

window.requestNotificationPermission = () => {
    if ('Notification' in window) {
        Notification.requestPermission();
    }
};

window.showNotificationPanel = async () => {
    const modal = document.getElementById('notificationModal');
    if (!modal) return;

    try {
        const res = await fetch('/api/notifications', { headers: getAuthHeaders() });
        if (res.ok) {
            const items = await res.json();
            const list = document.getElementById('notificationList');
            if (items.length === 0) {
                list.innerHTML = '<div class="empty-state"><p>Bildirim yok</p></div>';
            } else {
                list.innerHTML = items.map(n => `
                    <div class="notification-item ${n.read ? 'read' : 'unread'}" onclick="markNotificationRead('${n.id}')">
                        <div class="notification-icon">${getNotificationIcon(n.type)}</div>
                        <div class="notification-content">
                            <div class="notification-message">${n.message}</div>
                            <div class="notification-time">${formatDate(n.timestamp)}</div>
                        </div>
                    </div>
                `).join('');
            }
            notificationCount = 0;
            updateNotificationBadge();
        }
    } catch (e) { }

    modal.classList.add('active');
};

window.closeNotificationModal = () => {
    document.getElementById('notificationModal')?.classList.remove('active');
};

window.markNotificationRead = async (id) => {
    await fetch(`/api/notifications/${id}/read`, { method: 'PUT', headers: getAuthHeaders() });
};

window.markAllNotificationsRead = async () => {
    await fetch('/api/notifications/read-all', { method: 'PUT', headers: getAuthHeaders() });
    showNotificationPanel();
};

window.clearAllNotifications = async () => {
    await fetch('/api/notifications', { method: 'DELETE', headers: getAuthHeaders() });
    showNotificationPanel();
};

function getNotificationIcon(type) {
    const icons = { upload: '📤', download: '📥', file_edited: '✏️', share: '🔗', backup: '💾', restore: '🔄' };
    return icons[type] || '🔔';
}

// ============================================================================
// BATCH OPERATIONS
// ============================================================================
window.showBatchMoveModal = () => {
    if (selectedFiles.size === 0) return;
    const modal = document.getElementById('batchMoveModal');
    if (!modal) return;
    document.getElementById('batchMoveCount').textContent = selectedFiles.size;
    document.getElementById('batchMoveDestination').value = '';
    modal.classList.add('active');
};

window.closeBatchMoveModal = () => {
    document.getElementById('batchMoveModal')?.classList.remove('active');
};

window.confirmBatchMove = async () => {
    const destination = document.getElementById('batchMoveDestination').value.trim();
    if (!destination) { showToast('Hedef klasor gerekli', 'error'); return; }

    const items = [...selectedFiles].map(name =>
        currentPath === '/' ? name : `${currentPath.replace(/^\//, '')}/${name}`
    );

    try {
        const res = await fetch('/api/batch/move', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ items, destination })
        });
        if (res.ok) {
            const data = await res.json();
            showToast(`${data.moved.length} dosya tasindi`, 'success');
            selectedFiles.clear();
            updateBulkActions();
            fetchContents();
            closeBatchMoveModal();
        }
    } catch (e) { showToast('Tasima hatasi', 'error'); }
};

window.showBatchTagModal = () => {
    if (selectedFiles.size === 0) return;
    const modal = document.getElementById('batchTagModal');
    if (!modal) return;
    document.getElementById('batchTagCount').textContent = selectedFiles.size;
    document.getElementById('batchTagInput').value = '';
    modal.classList.add('active');
};

window.closeBatchTagModal = () => {
    document.getElementById('batchTagModal')?.classList.remove('active');
};

window.confirmBatchTag = async (action = 'add') => {
    const tag = document.getElementById('batchTagInput').value.trim();
    if (!tag) { showToast('Etiket gerekli', 'error'); return; }

    const items = [...selectedFiles].map(name =>
        currentPath === '/' ? name : `${currentPath.replace(/^\//, '')}/${name}`
    );

    try {
        const res = await fetch('/api/batch/tag', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ items, tag, action })
        });
        if (res.ok) {
            showToast(`Etiket ${action === 'add' ? 'eklendi' : 'kaldirildi'}`, 'success');
            loadTags();
            fetchContents();
            closeBatchTagModal();
        }
    } catch (e) { showToast('Etiket hatasi', 'error'); }
};

window.showBatchRenameModal = () => {
    if (selectedFiles.size === 0) return;
    const modal = document.getElementById('batchRenameModal');
    if (!modal) return;
    document.getElementById('batchRenameCount').textContent = selectedFiles.size;
    document.getElementById('batchRenamePattern').value = '';
    document.getElementById('batchRenameReplacement').value = '';
    modal.classList.add('active');
};

window.closeBatchRenameModal = () => {
    document.getElementById('batchRenameModal')?.classList.remove('active');
};

window.confirmBatchRename = async () => {
    const pattern = document.getElementById('batchRenamePattern').value;
    const replacement = document.getElementById('batchRenameReplacement').value;
    if (!pattern) { showToast('Desen gerekli', 'error'); return; }

    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');

    try {
        const res = await fetch('/api/batch/rename', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ items: [...selectedFiles], pattern, replacement, parentPath })
        });
        if (res.ok) {
            const data = await res.json();
            showToast(`${data.renamed.length} dosya yeniden adlandirildi`, 'success');
            selectedFiles.clear();
            updateBulkActions();
            fetchContents();
            closeBatchRenameModal();
        }
    } catch (e) { showToast('Toplu adlandirma hatasi', 'error'); }
};

// ============================================================================
// FILE COMMENTS
// ============================================================================
window.showCommentsModal = async (filename) => {
    const modal = document.getElementById('commentsModal');
    if (!modal) return;

    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');
    document.getElementById('commentsFileName').textContent = filename;
    document.getElementById('commentInput').value = '';
    modal.setAttribute('data-filename', filename);

    try {
        const res = await fetch(`/api/comments/${encodeURIComponent(filename)}?parentPath=${encodeURIComponent(parentPath)}`, {
            headers: getAuthHeaders()
        });
        if (res.ok) {
            const cmts = await res.json();
            const list = document.getElementById('commentsList');
            if (cmts.length === 0) {
                list.innerHTML = '<p class="text-muted">Henuz yorum yok</p>';
            } else {
                list.innerHTML = cmts.map(c => `
                    <div class="comment-item">
                        <div class="comment-header">
                            <span class="comment-user">${c.user}</span>
                            <span class="comment-time">${formatDate(c.timestamp)}</span>
                            <button class="btn-icon-sm" onclick="deleteComment('${filename}', '${c.id}')" title="Sil">&times;</button>
                        </div>
                        <div class="comment-text">${escapeHtml(c.text)}</div>
                    </div>
                `).join('');
            }
        }
    } catch (e) { }

    modal.classList.add('active');
};

window.closeCommentsModal = () => {
    document.getElementById('commentsModal')?.classList.remove('active');
};

window.addComment = async () => {
    const modal = document.getElementById('commentsModal');
    const filename = modal?.getAttribute('data-filename');
    const text = document.getElementById('commentInput').value.trim();
    if (!text || !filename) return;

    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');

    try {
        const res = await fetch(`/api/comments/${encodeURIComponent(filename)}?parentPath=${encodeURIComponent(parentPath)}`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ text })
        });
        if (res.ok) {
            showToast('Yorum eklendi', 'success');
            showCommentsModal(filename);
        }
    } catch (e) { showToast('Yorum eklenemedi', 'error'); }
};

window.deleteComment = async (filename, commentId) => {
    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');
    try {
        await fetch(`/api/comments/${encodeURIComponent(filename)}?parentPath=${encodeURIComponent(parentPath)}&commentId=${commentId}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        showCommentsModal(filename);
    } catch (e) { }
};

// ============================================================================
// FILE VERSIONS
// ============================================================================
window.showVersionsModal = async (filename) => {
    const modal = document.getElementById('versionsModal');
    if (!modal) return;

    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');
    document.getElementById('versionsFileName').textContent = filename;

    try {
        const res = await fetch(`/api/versions/${encodeURIComponent(filename)}?parentPath=${encodeURIComponent(parentPath)}`, {
            headers: getAuthHeaders()
        });
        if (res.ok) {
            const versions = await res.json();
            const list = document.getElementById('versionsList');
            if (versions.length === 0) {
                list.innerHTML = '<p class="text-muted">Versiyon gecmisi yok</p>';
            } else {
                list.innerHTML = versions.map(v => `
                    <div class="version-item">
                        <div class="version-info">
                            <span class="version-date">${formatDate(v.timestamp)}</span>
                            <span class="version-size">${formatSize(v.size)}</span>
                        </div>
                        <button class="btn-sm btn-primary" onclick="restoreVersion('${filename}', '${v.id}')">Geri Yukle</button>
                    </div>
                `).join('');
            }
        }
    } catch (e) { }

    modal.classList.add('active');
};

window.closeVersionsModal = () => {
    document.getElementById('versionsModal')?.classList.remove('active');
};

window.restoreVersion = async (filename, versionId) => {
    if (!confirm('Bu versiyon geri yuklenecek. Mevcut dosya versiyonlanacak. Emin misiniz?')) return;

    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');

    try {
        const res = await fetch(`/api/versions/${encodeURIComponent(filename)}/restore/${versionId}?parentPath=${encodeURIComponent(parentPath)}`, {
            method: 'POST',
            headers: getAuthHeaders()
        });
        if (res.ok) {
            showToast('Versiyon geri yuklendi', 'success');
            showVersionsModal(filename);
        }
    } catch (e) { showToast('Geri yukleme hatasi', 'error'); }
};

// ============================================================================
// FILE CHECKSUM
// ============================================================================
window.showChecksum = async (filename) => {
    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');

    try {
        const res = await fetch(`/api/checksum/${encodeURIComponent(filename)}?parentPath=${encodeURIComponent(parentPath)}`, {
            headers: getAuthHeaders()
        });
        if (res.ok) {
            const data = await res.json();
            const propChecksum = document.getElementById('propChecksum');
            if (propChecksum) {
                propChecksum.textContent = data.checksum;
                propChecksum.title = `${data.algorithm.toUpperCase()}: ${data.checksum}`;
                // Show integrity status if stored checksum exists
                if (data.integrityOk === true) {
                    propChecksum.innerHTML = data.checksum + ' <span style="color:#22c55e; font-size:0.8rem;">&#10003; Butunluk dogrulandi</span>';
                } else if (data.integrityOk === false) {
                    propChecksum.innerHTML = data.checksum + ' <span style="color:#ef4444; font-size:0.8rem;">&#10007; BUTUNLUK HATASI!</span>';
                }
            }
            // Show verification row
            const verifyRow = document.getElementById('checksumVerifyRow');
            if (verifyRow) verifyRow.style.display = 'flex';
            // Reset verify state
            const verifyResult = document.getElementById('checksumVerifyResult');
            if (verifyResult) verifyResult.style.display = 'none';
            const verifyInput = document.getElementById('checksumVerifyInput');
            if (verifyInput) verifyInput.value = '';
        }
    } catch (e) { }
};

window.verifyChecksum = () => {
    const currentChecksum = document.getElementById('propChecksum')?.textContent?.trim();
    const inputChecksum = document.getElementById('checksumVerifyInput')?.value?.trim().toLowerCase();
    const resultEl = document.getElementById('checksumVerifyResult');
    if (!resultEl || !currentChecksum || !inputChecksum) return;

    resultEl.style.display = 'block';
    if (currentChecksum.toLowerCase() === inputChecksum) {
        resultEl.style.background = 'rgba(34, 197, 94, 0.15)';
        resultEl.style.color = '#22c55e';
        resultEl.textContent = 'Checksum eslesiyor! Dosya butunlugu dogrulandi.';
    } else {
        resultEl.style.background = 'rgba(239, 68, 68, 0.15)';
        resultEl.style.color = '#ef4444';
        resultEl.textContent = 'Checksum ESLESMIYOR! Dosya degistirilmis veya bozulmus olabilir.';
    }
};

// ============================================================================
// SEARCH HISTORY
// ============================================================================
let searchHistoryData = [];

async function loadSearchHistory() {
    try {
        const res = await fetch('/api/search/history', { headers: getAuthHeaders() });
        if (res.ok) {
            searchHistoryData = await res.json();
            renderSearchHistory();
        }
    } catch (e) { }
}

function renderSearchHistory() {
    const container = document.getElementById('searchHistoryList');
    if (!container) return;

    if (searchHistoryData.length === 0) {
        container.innerHTML = '<p class="text-muted">Arama gecmisi bos</p>';
        return;
    }

    container.innerHTML = searchHistoryData.slice(0, 10).map(s => `
        <div class="search-history-item" onclick="replaySearch('${escapeHtml(s.query)}')">
            <span class="search-history-query">${escapeHtml(s.query)}</span>
            <span class="search-history-time">${formatDate(s.timestamp)}</span>
            <button class="btn-icon-sm" onclick="event.stopPropagation(); deleteSearchHistory('${s.id}')">&times;</button>
        </div>
    `).join('');
}

window.replaySearch = (query) => {
    if (searchInput) {
        searchInput.value = query;
        applyFilterAndRender();
    }
    closeSearchHistoryPanel();
};

window.deleteSearchHistory = async (id) => {
    await fetch(`/api/search/history?id=${id}`, { method: 'DELETE', headers: getAuthHeaders() });
    loadSearchHistory();
};

window.clearSearchHistory = async () => {
    await fetch('/api/search/history', { method: 'DELETE', headers: getAuthHeaders() });
    searchHistoryData = [];
    renderSearchHistory();
};

window.showSearchHistoryPanel = () => {
    loadSearchHistory();
    document.getElementById('searchHistoryPanel')?.classList.add('active');
};

window.closeSearchHistoryPanel = () => {
    document.getElementById('searchHistoryPanel')?.classList.remove('active');
};

// Save search when advanced search is performed
const _originalAdvancedSearch = window.performAdvancedSearch;
window.performAdvancedSearch = async () => {
    const q = document.getElementById('advSearchQuery')?.value || '';
    if (q) {
        fetch('/api/search/history', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ query: q })
        }).catch(() => {});
    }
    await _originalAdvancedSearch();
};

// ============================================================================
// VIDEO THUMBNAIL SUPPORT
// ============================================================================
function getVideoThumbnailUrl(filename) {
    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');
    return `/api/thumbnail/${encodeURIComponent(filename)}?parentPath=${encodeURIComponent(parentPath)}`;
}

// ============================================================================
// ENHANCED CONTEXT MENU - Add new items
// ============================================================================
document.getElementById('ctxComments')?.addEventListener('click', () => {
    if (selectedFilename) showCommentsModal(selectedFilename);
});

document.getElementById('ctxVersions')?.addEventListener('click', () => {
    if (selectedFilename) showVersionsModal(selectedFilename);
});

// ============================================================================
// INIT NOTIFICATIONS ON LOAD
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
    // Request browser notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        // Request on first user interaction
        document.addEventListener('click', function reqPerm() {
            Notification.requestPermission();
            document.removeEventListener('click', reqPerm);
        }, { once: true });
    }

    // Load initial notification count after a short delay (ensure auth is ready)
    setTimeout(() => {
        fetch('/api/notifications?unreadOnly=true', { headers: getAuthHeaders() })
            .then(res => {
                if (!res.ok) throw new Error('Not ok');
                return res.json();
            })
            .then(data => {
                if (Array.isArray(data)) {
                    notificationCount = data.length;
                    updateNotificationBadge();
                }
            })
            .catch(() => {});
    }, 1500);
});
