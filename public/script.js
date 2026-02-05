const socket = io();

// State
let allFiles = [];
let currentFilter = 'all';
let currentSort = 'date';
let sortAscending = false;
let selectedFiles = new Set();
let isListView = false;
let currentPath = '/';  // Current folder path

// DOM Elements
const fileGrid = document.getElementById('fileGrid');
const searchInput = document.getElementById('searchInput');
const fileInput = document.getElementById('fileInput');
const dropOverlay = document.getElementById('dropOverlay');
const contextMenu = document.getElementById('contextMenu');
const gridContextMenu = document.getElementById('gridContextMenu');
const toastContainer = document.getElementById('toastContainer');
const uploadStatus = document.getElementById('uploadStatus');
const uploadProgress = document.getElementById('uploadProgress');
const uploadFileName = document.getElementById('uploadFileName');
const sectionTitle = document.getElementById('sectionTitle');
const fileCount = document.getElementById('fileCount');
const sortMenu = document.getElementById('sortMenu');
const sortBtn = document.getElementById('sortBtn');
const sortLabel = document.getElementById('sortLabel');
const themeSwitch = document.getElementById('themeSwitch');
const breadcrumbNav = document.getElementById('breadcrumbNav');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    fetchContents();
    loadTheme();
    updateStorageInfo();
    setupKeyboardShortcuts();
    setupGridContextMenu();
});

// --- Theme ---
function loadTheme() {
    const theme = localStorage.getItem('blackdrop-theme') || 'dark';
    if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        themeSwitch.classList.remove('active');
    } else {
        document.documentElement.removeAttribute('data-theme');
        themeSwitch.classList.add('active');
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
}

// --- Storage Info ---
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
            // Storage endpoint might not exist yet
            document.getElementById('storageValue').textContent = '-- / --';
        });
}

// --- Socket.io Events ---
socket.on('file:uploaded', (data) => {
    // Only update if we're in the same folder
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

// --- Content Fetching (Folders + Files) ---
function fetchContents() {
    showLoadingSkeletons();

    const pathParam = currentPath === '/' ? '' : currentPath.replace(/^\//, '');
    fetch(`/contents?path=${encodeURIComponent(pathParam)}`)
        .then(res => res.json())
        .then(data => {
            allFiles = data;
            updateBreadcrumbs();
            applyFilterAndRender();
        })
        .catch(err => {
            showToast('Dosyalar yüklenemedi', 'error');
            fileGrid.innerHTML = '';
        });
}

// Legacy function for backwards compatibility
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

// --- Sorting ---
function sortFiles(files) {
    const sorted = [...files];

    sorted.sort((a, b) => {
        let comparison = 0;

        switch (currentSort) {
            case 'name':
                comparison = a.name.localeCompare(b.name);
                break;
            case 'size':
                comparison = b.size - a.size;
                break;
            case 'type':
                comparison = a.type.localeCompare(b.type);
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

// Sort dropdown handling
sortBtn.addEventListener('click', (e) => {
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
    sortMenu.classList.remove('active');
});

// --- Rendering ---
function applyFilterAndRender() {
    let filtered = allFiles;

    // 1. Filter by Category
    if (currentFilter !== 'all') {
        if (currentFilter === 'media') {
            filtered = filtered.filter(f => f.type === 'image' || f.type === 'video');
        } else {
            filtered = filtered.filter(f => f.type === currentFilter);
        }
    }

    // 2. Filter by Search
    const searchTerm = searchInput.value.toLowerCase();
    if (searchTerm) {
        filtered = filtered.filter(f => f.name.toLowerCase().includes(searchTerm));
    }

    // 3. Sort
    filtered = sortFiles(filtered);

    // Update count (re-query since filterFiles may rebuild the element)
    document.getElementById('fileCount').textContent = filtered.length;

    renderGrid(filtered);
}

// --- Icons ---
function getIconForType(type) {
    const icons = {
        folder: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" 
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
        </svg>`,
        video: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" 
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
        </svg>`,
        document: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" 
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>`,
        image: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" 
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
        </svg>`,
        other: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" 
                d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
        </svg>`
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

    // Less than 24 hours
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        if (hours < 1) {
            const mins = Math.floor(diff / 60000);
            return mins <= 1 ? 'Just now' : `${mins}m ago`;
        }
        return `${hours}h ago`;
    }

    // Less than 7 days
    if (diff < 604800000) {
        const days = Math.floor(diff / 86400000);
        return days === 1 ? 'Yesterday' : `${days}d ago`;
    }

    // Default format
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
                <h3>No files yet</h3>
                <p>Drag and drop files here or click upload to get started</p>
            </div>
        `;
        return;
    }

    files.forEach((file, index) => {
        const card = document.createElement('div');
        card.className = 'file-card';
        card.draggable = true; // Enable Drag
        card.setAttribute('data-name', file.name);
        card.setAttribute('data-isfolder', file.isFolder);

        if (selectedFiles.has(file.name)) {
            card.classList.add('selected');
        }
        card.setAttribute('data-filename', file.name);
        card.style.animationDelay = `${index * 0.03}s`;

        let previewHtml = '';
        if (file.type === 'image') {
            previewHtml = `<img src="/download/${encodeURIComponent(file.name)}" loading="lazy" alt="${file.name}">`;
        } else {
            previewHtml = getIconForType(file.type);
        }

        const ext = getFileExtension(file.name);

        card.innerHTML = `
            <div class="file-checkbox">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/>
                </svg>
            </div>
            <div class="file-preview">
                ${previewHtml}
                <span class="file-type-badge">${ext}</span>
            </div>
            <div class="file-details">
                <div class="file-name" title="${file.name}">${file.name}</div>
                <div class="file-meta">
                    <span class="file-size">${formatSize(file.size)}</span>
                    <span class="file-date">${formatDate(file.date)}</span>
                </div>
            </div>
        `;

        // Interactions
        card.addEventListener('dblclick', () => previewFile(file.name));
        card.addEventListener('contextmenu', (e) => showContextMenu(e, file.name));

        card.addEventListener('click', (e) => {
            if (e.ctrlKey || e.metaKey) {
                // Toggle selection
                if (selectedFiles.has(file.name)) {
                    selectedFiles.delete(file.name);
                    card.classList.remove('selected');
                } else {
                    selectedFiles.add(file.name);
                    card.classList.add('selected');
                }
            } else {
                // Single selection
                selectedFiles.clear();
                document.querySelectorAll('.file-card').forEach(c => c.classList.remove('selected'));
                selectedFiles.add(file.name);
                card.classList.add('selected');
            }
        });

        // Drag & Drop Events
        card.addEventListener('dragstart', handleDragStart);
        if (file.isFolder) {
            card.addEventListener('dragover', handleDragOver);
            card.addEventListener('dragleave', handleDragLeave);
            card.addEventListener('drop', handleDrop);
        }

        fileGrid.appendChild(card);
    });
}

// --- Sidebar Filtering ---
window.filterFiles = (type) => {
    currentFilter = type;

    // Update active state
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-filter="${type}"]`).classList.add('active');

    // Update Title
    const titles = { 'all': 'All Files', 'media': 'Media', 'document': 'Documents' };
    sectionTitle.innerHTML = `${titles[type] || 'Files'} <span class="file-count" id="fileCount">0</span>`;

    applyFilterAndRender();
}

searchInput.addEventListener('input', applyFilterAndRender);

// --- View Toggle ---
const viewToggleBtn = document.getElementById('viewToggleBtn');
const viewIcon = document.getElementById('viewIcon');

viewToggleBtn.addEventListener('click', () => {
    isListView = !isListView;
    fileGrid.classList.toggle('list-view', isListView);

    // Update icon
    if (isListView) {
        viewIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
            d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/>`;
    } else {
        viewIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>`;
    }
});

// --- Upload Logic ---
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

// Drag & Drop
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
    // Only show overlay if dragging files from outside (not internal file cards)
    const types = e.dataTransfer.types;
    const isExternalFile = types.includes('Files') && !types.includes('text/plain');
    
    if (isExternalFile) {
        e.preventDefault();
        dragCounter++;
        dropOverlay.classList.add('active');
    }
});

document.addEventListener('dragleave', (e) => {
    dragCounter--;
    if (dragCounter === 0) {
        dropOverlay.classList.remove('active');
    }
});

document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('active');

    // Only handle file upload if files are being dropped (not internal drag-drop)
    const isInternalDrag = e.dataTransfer.getData('text/plain');
    
    if (!isInternalDrag && (e.target === dropOverlay || dropOverlay.contains(e.target) || e.target === document.body)) {
        handleFiles(e.dataTransfer.files);
    }
});

document.addEventListener('dragover', (e) => {
    e.preventDefault();
});

function handleFiles(files) {
    if (!files.length) return;
    [...files].forEach(uploadFile);
}

function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    // Show Progress UI
    uploadStatus.style.display = 'block';
    uploadFileName.textContent = file.name;
    uploadProgress.style.width = '0%';

    const xhr = new XMLHttpRequest();
    const parentPathQuery = currentPath === '/' ? '' : `?parentPath=${encodeURIComponent(currentPath)}`;
    xhr.open('POST', `/upload${parentPathQuery}`, true);

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const percent = (e.loaded / e.total) * 100;
            uploadProgress.style.width = percent + '%';
        }
    };

    xhr.onload = () => {
        if (xhr.status === 200) {
            // Toast handled by socket event
        } else {
            showToast('Upload failed', 'error');
        }
        setTimeout(() => {
            uploadStatus.style.display = 'none';
            uploadProgress.style.width = '0%';
        }, 1000);
    };

    xhr.onerror = () => {
        showToast('Upload failed', 'error');
        uploadStatus.style.display = 'none';
    };

    xhr.send(formData);
}

// --- Context Menu ---
let selectedFilename = null;

function showContextMenu(e, filename) {
    e.preventDefault();
    selectedFilename = filename;

    const menuWidth = 180;
    const menuHeight = 220;

    let x = e.pageX;
    let y = e.pageY;

    // Keep menu in viewport
    if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 10;
    }
    if (y + menuHeight > window.innerHeight) {
        y = window.innerHeight - menuHeight - 10;
    }

    contextMenu.style.display = 'block';
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
}

document.addEventListener('click', () => {
    contextMenu.style.display = 'none';
});

document.getElementById('ctxPreview').addEventListener('click', () => {
    if (selectedFilename) previewFile(selectedFilename);
});

document.getElementById('ctxDownload').addEventListener('click', () => {
    if (selectedFilename) downloadFile(selectedFilename);
});

document.getElementById('ctxRename').addEventListener('click', () => {
    if (selectedFilename) showRenameModal(selectedFilename);
});

document.getElementById('ctxDelete').addEventListener('click', () => {
    if (selectedFilename) showDeleteModal(selectedFilename);
});

document.getElementById('ctxProperties').addEventListener('click', () => {
    if (selectedFilename) showProperties(selectedFilename);
});

// --- Preview Modal ---
const previewModal = document.getElementById('previewModal');
const previewContainer = document.getElementById('previewContainer');
const previewTitle = document.getElementById('previewTitle');
const previewDownloadBtn = document.getElementById('previewDownloadBtn');

function previewFile(filename) {
    const file = allFiles.find(f => f.name === filename);
    if (!file) return;

    // Folder navigation
    if (file.isFolder) {
        const newPath = currentPath === '/'
            ? '/' + file.name
            : currentPath + '/' + file.name;
        navigateToFolder(newPath);
        return;
    }

    previewTitle.textContent = file.name;
    const parentPathQuery = currentPath === '/' ? '' : `?parentPath=${encodeURIComponent(currentPath)}`;
    const url = `/download/${encodeURIComponent(filename)}${parentPathQuery}`;
    const fullUrl = `${window.location.origin}${url}`;

    // Video formats that browsers can't play natively
    const nonBrowserFormats = ['.mkv', '.avi', '.wmv', '.flv', '.m4v'];
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    const isNonBrowserVideo = file.type === 'video' && nonBrowserFormats.includes(ext);

    if (file.type === 'image') {
        previewContainer.innerHTML = `<img src="${url}" alt="${file.name}">`;
    } else if (file.type === 'video' && !isNonBrowserVideo) {
        // Browser-playable video (mp4, webm, ogg)
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
    } else {
        // For other files, just download
        downloadFile(filename);
        return;
    }

    previewDownloadBtn.onclick = () => downloadFile(filename);
    previewModal.classList.add('active');
}

// Update Upload Function to support parentPath
// Note: You need to find where uploadFile is defined and update it.
// Assuming it's elsewhere in the file, I'll search for it first.

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
}

window.closePreviewModal = () => {
    previewModal.classList.remove('active');
    previewContainer.innerHTML = '';
}

previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) closePreviewModal();
});

// --- Rename Modal ---
const renameModal = document.getElementById('renameModal');
const renameInput = document.getElementById('renameInput');
let fileToRename = null;

function showRenameModal(filename) {
    fileToRename = filename;
    renameInput.value = filename;
    renameModal.classList.add('active');

    // Select filename without extension
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

window.closeRenameModal = () => {
    renameModal.classList.remove('active');
    fileToRename = null;
}

window.confirmRename = () => {
    const newName = renameInput.value.trim();
    if (!newName || newName === fileToRename) {
        closeRenameModal();
        return;
    }

    fetch(`/files/${encodeURIComponent(fileToRename)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName })
    })
        .then(res => {
            if (res.ok) {
                showToast('File renamed', 'success');
                // Update local state
                const file = allFiles.find(f => f.name === fileToRename);
                if (file) {
                    file.name = newName;
                    applyFilterAndRender();
                }
            } else {
                return res.json().then(data => {
                    throw new Error(data.error || 'Rename failed');
                });
            }
        })
        .catch(err => showToast(err.message, 'error'))
        .finally(() => closeRenameModal());
}

renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmRename();
    if (e.key === 'Escape') closeRenameModal();
});

renameModal.addEventListener('click', (e) => {
    if (e.target === renameModal) closeRenameModal();
});

// --- Delete Modal ---
const deleteModal = document.getElementById('deleteModal');
const deleteMessage = document.getElementById('deleteMessage');
let fileToDelete = null;

function showDeleteModal(filename) {
    fileToDelete = filename;
    deleteMessage.textContent = `"${filename}" will be permanently deleted.`;
    deleteModal.classList.add('active');
}

window.closeDeleteModal = () => {
    deleteModal.classList.remove('active');
    fileToDelete = null;
}

window.confirmDelete = () => {
    if (!fileToDelete) return;

    fetch(`/files/${encodeURIComponent(fileToDelete)}`, { method: 'DELETE' })
        .then(res => {
            if (res.ok) {
                showToast('File deleted', 'success');
            } else {
                showToast('Delete failed', 'error');
            }
        })
        .catch(() => showToast('Error deleting file', 'error'))
        .finally(() => closeDeleteModal());
}

deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) closeDeleteModal();
});

function downloadFile(name) {
    const link = document.createElement('a');
    link.href = `/download/${encodeURIComponent(name)}`;
    link.download = '';
    link.click();
}

// --- Properties Modal ---
const propertiesModal = document.getElementById('propertiesModal');
const propName = document.getElementById('propName');
const propType = document.getElementById('propType');
const propSize = document.getElementById('propSize');
const propDate = document.getElementById('propDate');

function showProperties(filename) {
    const file = allFiles.find(f => f.name === filename);
    if (!file) return;

    propName.textContent = file.name;
    propType.textContent = file.type.charAt(0).toUpperCase() + file.type.slice(1);
    propSize.textContent = formatSize(file.size);

    const date = new Date(file.date);
    propDate.textContent = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();

    contextMenu.style.display = 'none';
    propertiesModal.classList.add('active');
}

window.closePropertiesModal = () => {
    propertiesModal.classList.remove('active');
}

propertiesModal.addEventListener('click', (e) => {
    if (e.target === propertiesModal) closePropertiesModal();
});

// --- Keyboard Shortcuts ---
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Don't trigger shortcuts when typing in input
        if (e.target.tagName === 'INPUT') return;

        // Delete selected files
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedFiles.size === 1) {
                const filename = [...selectedFiles][0];
                showDeleteModal(filename);
            }
        }

        // Select all (Ctrl/Cmd + A)
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            allFiles.forEach(f => selectedFiles.add(f.name));
            document.querySelectorAll('.file-card').forEach(c => c.classList.add('selected'));
        }

        // View toggle (V)
        if (e.key === 'v' || e.key === 'V') {
            viewToggleBtn.click();
        }

        // Focus search (/)
        if (e.key === '/') {
            e.preventDefault();
            searchInput.focus();
        }

        // Escape - close modals and clear selection
        if (e.key === 'Escape') {
            selectedFiles.clear();
            document.querySelectorAll('.file-card').forEach(c => c.classList.remove('selected'));
            closePreviewModal();
            closePropertiesModal();
            closeRenameModal();
            closeDeleteModal();
        }

        // Enter - preview selected file
        if (e.key === 'Enter' && selectedFiles.size === 1) {
            previewFile([...selectedFiles][0]);
        }
    });
}

// --- Utilities ---
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast';

    const iconSvg = type === 'success'
        ? `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
           </svg>`
        : type === 'error'
            ? `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
           </svg>`
            : '';

    toast.innerHTML = `
        <span class="toast-icon ${type}">${iconSvg}</span>
        <span>${msg}</span>
    `;

    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- Lasso Selection (Drag to Select) ---
let isSelecting = false;
let selectionBox = null;
let selectionStart = { x: 0, y: 0 };
let previouslySelectedFiles = new Set();

function initLassoSelection() {
    const mainContent = document.querySelector('.main-content');

    mainContent.addEventListener('mousedown', handleSelectionStart);
    document.addEventListener('mousemove', handleSelectionMove);
    document.addEventListener('mouseup', handleSelectionEnd);
}

function handleSelectionStart(e) {
    // Only handle left mouse button (button 0)
    if (e.button !== 0) return;

    // Don't start selection if clicking on interactive elements
    const isInteractive = e.target.closest('.file-card, .upload-btn, .icon-btn, .sort-btn, .search-bar, .nav-item, .theme-switch, button, input, a, .modal-overlay');
    if (isInteractive) return;

    // Store previously selected files if holding Ctrl/Cmd
    if (e.ctrlKey || e.metaKey) {
        previouslySelectedFiles = new Set(selectedFiles);
    } else {
        previouslySelectedFiles.clear();
        selectedFiles.clear();
        document.querySelectorAll('.file-card').forEach(c => c.classList.remove('selected'));
    }

    isSelecting = true;
    selectionStart = { x: e.pageX, y: e.pageY };

    // Create selection box
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

    // Calculate box dimensions
    const currentX = e.pageX;
    const currentY = e.pageY;

    const left = Math.min(selectionStart.x, currentX);
    const top = Math.min(selectionStart.y, currentY);
    const width = Math.abs(currentX - selectionStart.x);
    const height = Math.abs(currentY - selectionStart.y);

    // Update selection box position and size
    selectionBox.style.left = left + 'px';
    selectionBox.style.top = top + 'px';
    selectionBox.style.width = width + 'px';
    selectionBox.style.height = height + 'px';

    // Get selection box bounds (in viewport coordinates)
    const boxRect = {
        left: left,
        top: top,
        right: left + width,
        bottom: top + height
    };

    // Check which file cards intersect with selection box
    document.querySelectorAll('.file-card').forEach(card => {
        const cardRect = card.getBoundingClientRect();
        // Convert to page coordinates
        const cardPageRect = {
            left: cardRect.left + window.scrollX,
            top: cardRect.top + window.scrollY,
            right: cardRect.right + window.scrollX,
            bottom: cardRect.bottom + window.scrollY
        };

        // Check intersection
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
}

function handleSelectionEnd(e) {
    if (!isSelecting) return;

    isSelecting = false;
    document.body.classList.remove('selecting');

    if (selectionBox) {
        selectionBox.remove();
        selectionBox = null;
    }

    previouslySelectedFiles.clear();
}

// Initialize lasso selection after DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    initLassoSelection();
});

// --- Folder Navigation ---
window.navigateToFolder = (path) => {
    currentPath = path;
    selectedFiles.clear();
    fetchContents();
}

function updateBreadcrumbs() {
    // Clear existing breadcrumbs except home
    const existingItems = breadcrumbNav.querySelectorAll('.breadcrumb-item:not(.home)');
    existingItems.forEach(item => item.remove());

    // Remove separators
    const separators = breadcrumbNav.querySelectorAll('.breadcrumb-separator');
    separators.forEach(sep => sep.remove());

    if (currentPath === '/') {
        sectionTitle.innerHTML = `All Files <span class="file-count" id="fileCount">0</span>`;
        return; // Only show home icon at root
    }

    // Build breadcrumb path
    const parts = currentPath.replace(/^\//, '').split('/').filter(p => p);
    let accumulatedPath = '';

    parts.forEach((part, index) => {
        accumulatedPath += '/' + part;
        const pathForClick = accumulatedPath;

        // Add separator
        const separator = document.createElement('span');
        separator.className = 'breadcrumb-separator';
        separator.innerHTML = `<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
        </svg>`;
        breadcrumbNav.appendChild(separator);

        // Add folder item
        const item = document.createElement('div');
        item.className = 'breadcrumb-item';
        item.textContent = part;
        item.onclick = () => navigateToFolder(pathForClick);
        breadcrumbNav.appendChild(item);
    });

    // Update section title
    const folderName = parts[parts.length - 1] || 'All Files';
    sectionTitle.innerHTML = `${folderName} <span class="file-count" id="fileCount">0</span>`;
}

// --- Grid Context Menu (right-click on empty space) ---
function setupGridContextMenu() {
    const mainContent = document.querySelector('.main-content');

    mainContent.addEventListener('contextmenu', (e) => {
        // Check if right-clicked on empty space (not on a file card)
        const isOnFileCard = e.target.closest('.file-card');
        if (isOnFileCard) return; // Let file context menu handle this

        // Check if clicked within content area
        const isInContentArea = e.target.closest('.content-area') ||
            e.target.closest('.file-grid');
        if (!isInContentArea) return;

        e.preventDefault();

        // Hide file context menu
        contextMenu.style.display = 'none';

        // Show grid context menu
        const menuWidth = 150;
        const menuHeight = 50;

        let x = e.pageX;
        let y = e.pageY;

        if (x + menuWidth > window.innerWidth) {
            x = window.innerWidth - menuWidth - 10;
        }
        if (y + menuHeight > window.innerHeight) {
            y = window.innerHeight - menuHeight - 10;
        }

        gridContextMenu.style.display = 'block';
        gridContextMenu.style.left = `${x}px`;
        gridContextMenu.style.top = `${y}px`;
    });

    // Hide menu on click
    document.addEventListener('click', () => {
        gridContextMenu.style.display = 'none';
    });

    // Create folder handler
    document.getElementById('ctxCreateFolder').addEventListener('click', () => {
        showCreateFolderModal();
    });
}

// --- Create Folder Modal ---
const createFolderModal = document.getElementById('createFolderModal');
const folderNameInput = document.getElementById('folderNameInput');

function showCreateFolderModal() {
    folderNameInput.value = '';
    createFolderModal.classList.add('active');
    setTimeout(() => folderNameInput.focus(), 100);
}

window.closeCreateFolderModal = () => {
    createFolderModal.classList.remove('active');
}

window.confirmCreateFolder = () => {
    const name = folderNameInput.value.trim();
    if (!name) {
        showToast('Klasör adı gerekli', 'error');
        return;
    }

    const parentPath = currentPath === '/' ? '' : currentPath.replace(/^\//, '');

    fetch('/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentPath })
    })
        .then(res => {
            if (res.ok) {
                return res.json();
            } else {
                return res.json().then(data => {
                    throw new Error(data.error || 'Klasör oluşturulamadı');
                });
            }
        })
        .then(data => {
            closeCreateFolderModal();
            // Socket event will handle adding to list
        })
        .catch(err => showToast(err.message, 'error'));
}

folderNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmCreateFolder();
    if (e.key === 'Escape') closeCreateFolderModal();
});

createFolderModal.addEventListener('click', (e) => {
    if (e.target === createFolderModal) closeCreateFolderModal();
});

// --- Drag & Drop Handlers ---
function handleDragStart(e) {
    const card = e.target.closest('.file-card');
    const name = card.getAttribute('data-name');
    e.dataTransfer.setData('text/plain', name);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
}

function handleDragOver(e) {
    // Prevent default to allow drop
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Add visual feedback
    const card = e.target.closest('.file-card');
    if (card && card.getAttribute('data-isfolder') === 'true') {
        card.classList.add('drop-target');
    }
    return false;
}

function handleDragLeave(e) {
    const card = e.target.closest('.file-card');
    if (card) card.classList.remove('drop-target');
}

function handleDrop(e) {
    e.stopPropagation();
    e.preventDefault();

    const destCard = e.target.closest('.file-card');
    if (destCard) destCard.classList.remove('drop-target');

    // Get source name from dataTransfer
    const sourceName = e.dataTransfer.getData('text/plain');
    
    // If no sourceName, this might be an external file drop - ignore it here
    if (!sourceName) return;
    
    if (!destCard) return;

    const destName = destCard.getAttribute('data-name');

    // Cleanup dragging class from all cards
    document.querySelectorAll('.file-card').forEach(c => c.classList.remove('dragging'));

    // Validation
    if (sourceName === destName) return; // Dropped on itself
    if (destCard.getAttribute('data-isfolder') !== 'true') return; // Dropped on file, not folder

    // Construct paths
    const parent = currentPath === '/' ? '' : currentPath;
    const sourcePath = parent + '/' + sourceName;
    const destinationPath = parent + '/' + destName;

    // Call API
    fetch('/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            source: sourcePath,
            destination: destinationPath
        })
    })
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                showToast(data.error, 'error');
            } else {
                showToast('Dosya taşındı', 'success');
                // Remove source card from UI (Socket will handle sync but this feels faster)
                const sourceCard = document.querySelector(`.file-card[data-name="${sourceName}"]`);
                if (sourceCard) sourceCard.remove();
            }
        })
        .catch(err => {
            showToast('Taşıma işlemi başarısız', 'error');
            console.error(err);
        });

    return false;
}
