const socket = io();

// State
let allFiles = [];
let currentFilter = 'all';
let currentSort = 'date';
let sortAscending = false;
let selectedFiles = new Set();
let isListView = false;

// DOM Elements
const fileGrid = document.getElementById('fileGrid');
const searchInput = document.getElementById('searchInput');
const fileInput = document.getElementById('fileInput');
const dropOverlay = document.getElementById('dropOverlay');
const contextMenu = document.getElementById('contextMenu');
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

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    fetchFiles();
    loadTheme();
    updateStorageInfo();
    setupKeyboardShortcuts();
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
socket.on('file:uploaded', (file) => {
    allFiles.unshift(file);
    applyFilterAndRender();
    showToast(`File uploaded: ${file.name}`, 'success');
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

// --- File Fetching ---
function fetchFiles() {
    showLoadingSkeletons();

    fetch('/files')
        .then(res => res.json())
        .then(data => {
            allFiles = data;
            applyFilterAndRender();
        })
        .catch(err => {
            showToast('Failed to load files', 'error');
            fileGrid.innerHTML = '';
        });
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
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.add('active');
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

    if (e.target === dropOverlay || dropOverlay.contains(e.target) || e.target === document.body) {
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
    xhr.open('POST', '/upload', true);

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

    previewTitle.textContent = file.name;
    const url = `/download/${encodeURIComponent(filename)}`;
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
