const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Server } = require("socket.io");
const os = require('os');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const archiver = require('archiver');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const compression = require('compression');
const helmet = require('helmet');
const NodeCache = require('node-cache');

const app = express();

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    PORT: 3000,
    JWT_SECRET: process.env.JWT_SECRET || 'blackdrop-secret-key-change-in-production-' + uuidv4(),
    JWT_EXPIRES_IN: '7d',
    UPLOAD_DIR: path.join(__dirname, 'uploads'),
    TRASH_DIR: path.join(__dirname, '.trash'),
    DATA_DIR: path.join(__dirname, '.data'),
    TOTAL_QUOTA: 10 * 1024 * 1024 * 1024, // 10GB
    MAX_FILE_SIZE: 10 * 1024 * 1024 * 1024, // 10GB
    SHARE_LINK_EXPIRY: 7 * 24 * 60 * 60 * 1000, // 7 days
    TRASH_AUTO_DELETE: 30 * 24 * 60 * 60 * 1000, // 30 days
    RATE_LIMIT_WINDOW: 15 * 60 * 1000, // 15 minutes
    RATE_LIMIT_MAX: 100, // requests per window
};

// ============================================================================
// INITIALIZE DIRECTORIES AND DATA STORES
// ============================================================================
[CONFIG.UPLOAD_DIR, CONFIG.TRASH_DIR, CONFIG.DATA_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Data file paths
const DATA_FILES = {
    users: path.join(CONFIG.DATA_DIR, 'users.json'),
    shares: path.join(CONFIG.DATA_DIR, 'shares.json'),
    favorites: path.join(CONFIG.DATA_DIR, 'favorites.json'),
    recent: path.join(CONFIG.DATA_DIR, 'recent.json'),
    tags: path.join(CONFIG.DATA_DIR, 'tags.json'),
    activity: path.join(CONFIG.DATA_DIR, 'activity.json'),
    downloads: path.join(CONFIG.DATA_DIR, 'downloads.json'),
    ipConfig: path.join(CONFIG.DATA_DIR, 'ip-config.json'),
    settings: path.join(CONFIG.DATA_DIR, 'settings.json'),
    storageLocations: path.join(CONFIG.DATA_DIR, 'storage-locations.json')
};

// Initialize data files
function loadData(file, defaultValue = {}) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) { console.error(`Error loading ${file}:`, e); }
    return defaultValue;
}

function saveData(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) { console.error(`Error saving ${file}:`, e); }
}

// In-memory data stores
let users = loadData(DATA_FILES.users, { admin: { password: bcrypt.hashSync('admin', 10), role: 'admin' } });
let shares = loadData(DATA_FILES.shares, {});
let favorites = loadData(DATA_FILES.favorites, []);
let recentFiles = loadData(DATA_FILES.recent, []);
let tags = loadData(DATA_FILES.tags, {});
let activityLog = loadData(DATA_FILES.activity, []);
let downloadCounts = loadData(DATA_FILES.downloads, {});
let ipConfig = loadData(DATA_FILES.ipConfig, { whitelist: [], blacklist: [], mode: 'none' });
let settings = loadData(DATA_FILES.settings, { authEnabled: false, notificationsEnabled: false });
let storageLocations = loadData(DATA_FILES.storageLocations, [
    { id: 'default', name: 'Ana Depolama', path: CONFIG.UPLOAD_DIR, enabled: true, isDefault: true }
]);

// Cache for thumbnails
const thumbnailCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// Save data periodically
setInterval(() => {
    saveData(DATA_FILES.users, users);
    saveData(DATA_FILES.shares, shares);
    saveData(DATA_FILES.favorites, favorites);
    saveData(DATA_FILES.recent, recentFiles);
    saveData(DATA_FILES.tags, tags);
    saveData(DATA_FILES.activity, activityLog);
    saveData(DATA_FILES.downloads, downloadCounts);
    saveData(DATA_FILES.ipConfig, ipConfig);
    saveData(DATA_FILES.settings, settings);
    saveData(DATA_FILES.storageLocations, storageLocations);
}, 60000); // Every minute

// ============================================================================
// SSL SETUP
// ============================================================================
const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem'))
};

const server = https.createServer(sslOptions, app);
const io = new Server(server);

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Security headers
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// Compression
app.use(compression());

// CORS
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: CONFIG.RATE_LIMIT_WINDOW,
    max: CONFIG.RATE_LIMIT_MAX,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/', limiter);

// Auth rate limiting (stricter)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many login attempts, please try again later.' }
});

// Static files
app.use(express.static('public'));

// Share page route
app.get('/share/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// Admin panel page route
app.get('/admin-panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getClientIp(req) {
    return (req.headers['x-forwarded-for']?.split(',')[0] ||
        req.connection?.remoteAddress ||
        req.socket?.remoteAddress ||
        req.ip || 'unknown').replace('::ffff:', '');
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getFileType(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(ext)) return 'image';
    if (['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.m4v'].includes(ext)) return 'video';
    if (['.pdf'].includes(ext)) return 'pdf';
    if (['.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.rtf', '.odt'].includes(ext)) return 'document';
    if (['.md'].includes(ext)) return 'markdown';
    if (['.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.css', '.html', '.json', '.xml', '.yml', '.yaml', '.sh', '.bash', '.sql', '.php', '.rb', '.go', '.rs', '.swift', '.kt'].includes(ext)) return 'code';
    if (['.mp3', '.wav', '.flac', '.aac', '.m4a', '.wma', '.opus'].includes(ext)) return 'audio';
    if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'].includes(ext)) return 'archive';
    return 'other';
}

function getDirectorySizeRecursive(dirPath) {
    let totalSize = 0;
    try {
        const items = fs.readdirSync(dirPath);
        for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const stats = fs.statSync(itemPath);
            if (stats.isFile()) {
                totalSize += stats.size;
            } else if (stats.isDirectory()) {
                totalSize += getDirectorySizeRecursive(itemPath);
            }
        }
    } catch (e) { }
    return totalSize;
}

function safeResolvePath(relativePath, baseDir = CONFIG.UPLOAD_DIR) {
    const cleanPath = (relativePath || '').replace(/^\/+/, '').replace(/\.\./g, '');
    const resolved = path.join(baseDir, cleanPath);
    if (!resolved.startsWith(baseDir)) return null;
    return resolved;
}

function logActivity(action, details, ip, user = 'anonymous') {
    const entry = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        action,
        details,
        ip,
        user
    };
    
    // Log to terminal
    console.log(`[${new Date().toLocaleTimeString()}] [${action.toUpperCase()}] User: ${user} | IP: ${ip} | ${details}`);
    
    activityLog.unshift(entry);
    if (activityLog.length > 1000) activityLog = activityLog.slice(0, 1000);
    io.emit('activity:new', entry);
    return entry;
}

function addToRecent(filePath, action = 'opened') {
    const entry = {
        path: filePath,
        action,
        timestamp: new Date().toISOString()
    };
    recentFiles = recentFiles.filter(r => r.path !== filePath);
    recentFiles.unshift(entry);
    if (recentFiles.length > 50) recentFiles = recentFiles.slice(0, 50);
}

function cleanExpiredShares() {
    const now = Date.now();
    Object.keys(shares).forEach(key => {
        if (shares[key].expiresAt && new Date(shares[key].expiresAt).getTime() < now) {
            delete shares[key];
        }
    });
}

function cleanTrash() {
    const now = Date.now();
    try {
        const trashMetaFile = path.join(CONFIG.TRASH_DIR, '.meta.json');
        if (fs.existsSync(trashMetaFile)) {
            const meta = JSON.parse(fs.readFileSync(trashMetaFile, 'utf8'));
            Object.keys(meta).forEach(key => {
                if (now - new Date(meta[key].deletedAt).getTime() > CONFIG.TRASH_AUTO_DELETE) {
                    const itemPath = path.join(CONFIG.TRASH_DIR, key);
                    if (fs.existsSync(itemPath)) {
                        fs.rmSync(itemPath, { recursive: true, force: true });
                    }
                    delete meta[key];
                }
            });
            fs.writeFileSync(trashMetaFile, JSON.stringify(meta, null, 2));
        }
    } catch (e) { console.error('Trash cleanup error:', e); }
}

// Cleanup jobs
setInterval(cleanExpiredShares, 60000);
setInterval(cleanTrash, 3600000);

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

function authenticateToken(req, res, next) {
    // Check if auth is disabled
    if (!settings.authEnabled) {
        req.user = { username: 'guest', role: 'admin' };
        return next();
    }

    // Allow public share access
    if (req.path.startsWith('/api/share/') || req.path.startsWith('/share/')) {
        return next();
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    jwt.verify(token, CONFIG.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
}

// IP filtering middleware
function ipFilter(req, res, next) {
    const clientIp = getClientIp(req);
    req.clientIp = clientIp;

    if (ipConfig.mode === 'whitelist' && ipConfig.whitelist.length > 0) {
        if (!ipConfig.whitelist.includes(clientIp)) {
            logActivity('blocked', `IP not in whitelist: ${clientIp}`, clientIp);
            return res.status(403).json({ error: 'Access denied' });
        }
    }

    if (ipConfig.mode === 'blacklist' && ipConfig.blacklist.includes(clientIp)) {
        logActivity('blocked', `IP blacklisted: ${clientIp}`, clientIp);
        return res.status(403).json({ error: 'Access denied' });
    }

    next();
}

app.use(ipFilter);

// ============================================================================
// MULTER CONFIGURATION
// ============================================================================

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const parentPath = (req.query.parentPath || '').replace(/^\/+/, '').replace(/\.\./g, '');
        const targetDir = path.join(CONFIG.UPLOAD_DIR, parentPath);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        req.uploadParentPath = parentPath;
        cb(null, targetDir);
    },
    filename: (req, file, cb) => {
        const parentPath = (req.query.parentPath || '').replace(/^\/+/, '').replace(/\.\./g, '');
        const targetDir = path.join(CONFIG.UPLOAD_DIR, parentPath);
        let filename = file.originalname;
        let filePath = path.join(targetDir, filename);
        let counter = 1;
        while (fs.existsSync(filePath)) {
            const ext = path.extname(file.originalname);
            const name = path.basename(file.originalname, ext);
            filename = `${name} (${counter})${ext}`;
            filePath = path.join(targetDir, filename);
            counter++;
        }
        cb(null, filename);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: CONFIG.MAX_FILE_SIZE }
});

// Chunked upload storage
const chunkStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const chunkDir = path.join(CONFIG.DATA_DIR, 'chunks', req.body.uploadId || 'temp');
        if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });
        cb(null, chunkDir);
    },
    filename: (req, file, cb) => {
        cb(null, `chunk-${req.body.chunkIndex}`);
    }
});
const chunkUpload = multer({ storage: chunkStorage });

// ============================================================================
// SOCKET.IO
// ============================================================================

io.on('connection', (socket) => {
    const ip = (socket.handshake.headers['x-forwarded-for']?.split(',')[0] ||
        socket.handshake.address || 'unknown').replace('::ffff:', '');
    console.log(`🟢 ${ip} connected`);

    socket.on('disconnect', () => {
        console.log(`🔴 ${ip} disconnected`);
    });
});

// ============================================================================
// AUTH ROUTES
// ============================================================================

// Check auth status
app.get('/api/auth/status', (req, res) => {
    res.json({ authEnabled: settings.authEnabled });
});

// Login
app.post('/api/auth/login', authLimiter, (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    const user = users[username];
    if (!user || !bcrypt.compareSync(password, user.password)) {
        logActivity('login_failed', `Failed login attempt for: ${username}`, getClientIp(req));
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ username, role: user.role }, CONFIG.JWT_SECRET, { expiresIn: CONFIG.JWT_EXPIRES_IN });
    logActivity('login', `User logged in: ${username}`, getClientIp(req), username);

    res.json({ token, username, role: user.role });
});

// Register (admin only or first user)
app.post('/api/auth/register', (req, res) => {
    const { username, password, role = 'user' } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    if (users[username]) {
        return res.status(400).json({ error: 'Username already exists' });
    }

    users[username] = {
        password: bcrypt.hashSync(password, 10),
        role
    };
    saveData(DATA_FILES.users, users);

    logActivity('register', `New user registered: ${username}`, getClientIp(req));
    res.json({ message: 'User registered successfully' });
});

// Change password
app.post('/api/auth/change-password', authenticateToken, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const username = req.user.username;

    if (!users[username] || !bcrypt.compareSync(currentPassword, users[username].password)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }

    users[username].password = bcrypt.hashSync(newPassword, 10);
    saveData(DATA_FILES.users, users);

    res.json({ message: 'Password changed successfully' });
});

// ============================================================================
// FILE ROUTES
// ============================================================================

// Upload
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const parentPath = req.uploadParentPath || '';
    const fileData = {
        name: req.file.filename,
        size: req.file.size,
        date: new Date(),
        type: getFileType(req.file.filename),
        isFolder: false
    };

    io.emit('file:uploaded', { file: fileData, parentPath: parentPath || '/' });
    logActivity('upload', `Uploaded: ${req.file.filename} (${formatBytes(req.file.size)})`, req.clientIp, req.user?.username);

    res.json({ message: 'File uploaded successfully', filename: req.file.filename, parentPath });
});

// Chunked upload - initialize
app.post('/api/upload/init', authenticateToken, (req, res) => {
    const { filename, totalSize, totalChunks } = req.body;
    const uploadId = uuidv4();
    
    res.json({ uploadId, message: 'Upload initialized' });
});

// Chunked upload - chunk
app.post('/api/upload/chunk', authenticateToken, chunkUpload.single('chunk'), (req, res) => {
    const { uploadId, chunkIndex, totalChunks, filename, parentPath } = req.body;
    
    res.json({ message: 'Chunk uploaded', chunkIndex });
});

// Chunked upload - complete
app.post('/api/upload/complete', authenticateToken, async (req, res) => {
    const { uploadId, filename, totalChunks, parentPath = '' } = req.body;
    const chunkDir = path.join(CONFIG.DATA_DIR, 'chunks', uploadId);
    const targetDir = path.join(CONFIG.UPLOAD_DIR, parentPath.replace(/^\/+/, '').replace(/\.\./g, ''));
    
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    
    const targetPath = path.join(targetDir, filename);
    const writeStream = fs.createWriteStream(targetPath);
    
    for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(chunkDir, `chunk-${i}`);
        const chunkData = fs.readFileSync(chunkPath);
        writeStream.write(chunkData);
    }
    
    writeStream.end();
    
    // Cleanup chunks
    fs.rmSync(chunkDir, { recursive: true, force: true });
    
    const stats = fs.statSync(targetPath);
    const fileData = {
        name: filename,
        size: stats.size,
        date: new Date(),
        type: getFileType(filename),
        isFolder: false
    };
    
    io.emit('file:uploaded', { file: fileData, parentPath: parentPath || '/' });
    logActivity('upload', `Uploaded (chunked): ${filename} (${formatBytes(stats.size)})`, req.clientIp, req.user?.username);
    
    res.json({ message: 'Upload complete', filename });
});

// List contents
app.get('/api/contents', authenticateToken, (req, res) => {
    const folderPath = safeResolvePath(req.query.path || '');
    if (!folderPath || !fs.existsSync(folderPath)) {
        return res.status(404).json({ error: 'Folder not found' });
    }

    try {
        const items = fs.readdirSync(folderPath);
        const contents = items
            .filter(item => !item.startsWith('.'))
            .map(item => {
                const itemPath = path.join(folderPath, item);
                try {
                    const stats = fs.statSync(itemPath);
                    const isFolder = stats.isDirectory();
                    const relativePath = itemPath.replace(CONFIG.UPLOAD_DIR, '').replace(/^\//, '');
                    return {
                        name: item,
                        isFolder,
                        size: isFolder ? getDirectorySizeRecursive(itemPath) : stats.size,
                        date: stats.mtime,
                        type: isFolder ? 'folder' : getFileType(item),
                        itemCount: isFolder ? fs.readdirSync(itemPath).filter(f => !f.startsWith('.')).length : 0,
                        isFavorite: favorites.includes(relativePath),
                        tags: tags[relativePath] || [],
                        downloadCount: downloadCounts[relativePath] || 0
                    };
                } catch (e) { return null; }
            })
            .filter(item => item !== null);

        contents.sort((a, b) => {
            if (a.isFolder && !b.isFolder) return -1;
            if (!a.isFolder && b.isFolder) return 1;
            return new Date(b.date) - new Date(a.date);
        });

        res.json(contents);
    } catch (e) {
        res.status(500).json({ error: 'Unable to read folder' });
    }
});

// Download
app.get('/api/download/:filename(*)', (req, res) => {
    const filename = req.params.filename;
    const parentPath = req.query.parentPath || '';
    const inline = req.query.inline === 'true';
    const filePath = safeResolvePath(path.join(parentPath, filename));

    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const relativePath = filePath.replace(CONFIG.UPLOAD_DIR, '').replace(/^\//, '');
    downloadCounts[relativePath] = (downloadCounts[relativePath] || 0) + 1;
    addToRecent(relativePath, 'downloaded');
    logActivity('download', `Downloaded: ${filename}`, req.clientIp);

    if (inline) {
        // Serve file inline for preview (PDF, images, etc.)
        res.sendFile(filePath);
    } else {
        res.download(filePath);
    }
});

// Delete (move to trash)
app.delete('/api/files/:filename(*)', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    const parentPath = req.query.parentPath || '';
    const filePath = safeResolvePath(path.join(parentPath, filename));

    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    try {
        // Move to trash instead of permanent delete
        const trashId = uuidv4();
        const trashPath = path.join(CONFIG.TRASH_DIR, trashId);
        
        // Save metadata
        const trashMetaFile = path.join(CONFIG.TRASH_DIR, '.meta.json');
        let trashMeta = {};
        if (fs.existsSync(trashMetaFile)) {
            trashMeta = JSON.parse(fs.readFileSync(trashMetaFile, 'utf8'));
        }
        
        const stats = fs.statSync(filePath);
        trashMeta[trashId] = {
            originalName: filename,
            originalPath: path.join(parentPath, filename),
            deletedAt: new Date().toISOString(),
            size: stats.isDirectory() ? getDirectorySizeRecursive(filePath) : stats.size,
            isFolder: stats.isDirectory()
        };
        
        fs.renameSync(filePath, trashPath);
        fs.writeFileSync(trashMetaFile, JSON.stringify(trashMeta, null, 2));

        io.emit('file:deleted', { name: filename, parentPath });
        logActivity('delete', `Moved to trash: ${filename}`, req.clientIp, req.user?.username);

        res.json({ message: 'File moved to trash' });
    } catch (e) {
        res.status(500).json({ error: 'Could not delete file' });
    }
});

// Permanent delete
app.delete('/api/files/:filename(*)/permanent', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    const parentPath = req.query.parentPath || '';
    const filePath = safeResolvePath(path.join(parentPath, filename));

    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    try {
        fs.rmSync(filePath, { recursive: true, force: true });
        io.emit('file:deleted', { name: filename, parentPath });
        logActivity('permanent_delete', `Permanently deleted: ${filename}`, req.clientIp, req.user?.username);
        res.json({ message: 'File permanently deleted' });
    } catch (e) {
        res.status(500).json({ error: 'Could not delete file' });
    }
});

// Rename
app.put('/api/files/:filename(*)', authenticateToken, (req, res) => {
    const oldName = req.params.filename;
    const { newName } = req.body;
    const parentPath = req.query.parentPath || '';

    if (!newName) return res.status(400).json({ error: 'New name is required' });

    const oldPath = safeResolvePath(path.join(parentPath, oldName));
    const newPath = safeResolvePath(path.join(parentPath, newName));

    if (!oldPath || !fs.existsSync(oldPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    if (fs.existsSync(newPath)) {
        return res.status(400).json({ error: 'A file with this name already exists' });
    }

    try {
        fs.renameSync(oldPath, newPath);
        io.emit('file:renamed', { oldName, newName, parentPath });
        logActivity('rename', `Renamed: ${oldName} → ${newName}`, req.clientIp, req.user?.username);
        res.json({ message: 'File renamed', oldName, newName });
    } catch (e) {
        res.status(500).json({ error: 'Could not rename file' });
    }
});

// Create folder
app.post('/api/folders', authenticateToken, (req, res) => {
    const { name, parentPath } = req.body;

    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        return res.status(400).json({ error: 'Invalid folder name' });
    }

    const parentDir = safeResolvePath(parentPath || '');
    if (!parentDir) return res.status(400).json({ error: 'Invalid parent path' });

    const newFolderPath = path.join(parentDir, name);

    if (fs.existsSync(newFolderPath)) {
        return res.status(400).json({ error: 'A folder with this name already exists' });
    }

    try {
        fs.mkdirSync(newFolderPath, { recursive: true });
        const stats = fs.statSync(newFolderPath);
        const folderData = {
            name,
            isFolder: true,
            size: 0,
            date: stats.mtime,
            type: 'folder',
            itemCount: 0
        };

        io.emit('folder:created', { folder: folderData, parentPath: parentPath || '/' });
        logActivity('create_folder', `Created folder: ${name}`, req.clientIp, req.user?.username);
        res.json({ message: 'Folder created', folder: folderData });
    } catch (e) {
        res.status(500).json({ error: 'Could not create folder' });
    }
});

// Create file
app.post('/api/files/create', authenticateToken, (req, res) => {
    const { name, parentPath, content } = req.body;

    if (!name) return res.status(400).json({ error: 'File name is required' });
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        return res.status(400).json({ error: 'Invalid file name' });
    }

    const parentDir = safeResolvePath(parentPath || '');
    if (!parentDir) return res.status(400).json({ error: 'Invalid parent path' });

    const newFilePath = path.join(parentDir, name);

    if (fs.existsSync(newFilePath)) {
        return res.status(400).json({ error: 'A file with this name already exists' });
    }

    try {
        fs.writeFileSync(newFilePath, content || '');
        const stats = fs.statSync(newFilePath);
        const fileData = {
            name,
            isFolder: false,
            size: stats.size,
            date: stats.mtime,
            type: getFileType(name),
            itemCount: 0
        };

        io.emit('file:uploaded', { file: fileData, parentPath: parentPath || '/' });
        logActivity('create_file', `Created file: ${name}`, req.clientIp, req.user?.username);
        res.json({ message: 'File created', file: fileData });
    } catch (e) {
        res.status(500).json({ error: 'Could not create file' });
    }
});

// Delete folder
app.delete('/api/folders/*', authenticateToken, (req, res) => {
    const folderRelPath = req.params[0];
    const folderPath = safeResolvePath(folderRelPath);

    if (!folderPath || folderPath === CONFIG.UPLOAD_DIR) {
        return res.status(400).json({ error: 'Invalid folder path' });
    }

    if (!fs.existsSync(folderPath)) {
        return res.status(404).json({ error: 'Folder not found' });
    }

    try {
        // Move to trash
        const trashId = uuidv4();
        const trashPath = path.join(CONFIG.TRASH_DIR, trashId);
        
        const trashMetaFile = path.join(CONFIG.TRASH_DIR, '.meta.json');
        let trashMeta = fs.existsSync(trashMetaFile) ? JSON.parse(fs.readFileSync(trashMetaFile, 'utf8')) : {};
        
        trashMeta[trashId] = {
            originalName: path.basename(folderRelPath),
            originalPath: folderRelPath,
            deletedAt: new Date().toISOString(),
            size: getDirectorySizeRecursive(folderPath),
            isFolder: true
        };
        
        fs.renameSync(folderPath, trashPath);
        fs.writeFileSync(trashMetaFile, JSON.stringify(trashMeta, null, 2));

        io.emit('folder:deleted', { path: folderRelPath });
        logActivity('delete', `Moved folder to trash: ${folderRelPath}`, req.clientIp, req.user?.username);
        res.json({ message: 'Folder moved to trash' });
    } catch (e) {
        res.status(500).json({ error: 'Could not delete folder' });
    }
});

// Move item
app.post('/api/move', authenticateToken, (req, res) => {
    const { source, destination, name } = req.body;

    const sourcePath = safeResolvePath(source);
    const destDir = safeResolvePath(destination || '');

    if (!sourcePath || !destDir) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(sourcePath)) return res.status(404).json({ error: 'Source not found' });

    const itemName = name || path.basename(sourcePath);
    const destPath = path.join(destDir, itemName);

    if (fs.existsSync(destPath)) {
        return res.status(400).json({ error: 'An item with this name already exists at destination' });
    }

    try {
        fs.renameSync(sourcePath, destPath);
        io.emit('item:moved', { source, destination, name: itemName });
        logActivity('move', `Moved: ${source} → ${destination}/${itemName}`, req.clientIp, req.user?.username);
        res.json({ message: 'Item moved' });
    } catch (e) {
        res.status(500).json({ error: 'Could not move item' });
    }
});

// Storage info
app.get('/api/storage', authenticateToken, (req, res) => {
    const used = getDirectorySizeRecursive(CONFIG.UPLOAD_DIR);
    res.json({
        used,
        total: CONFIG.TOTAL_QUOTA,
        free: CONFIG.TOTAL_QUOTA - used
    });
});

// ============================================================================
// TRASH ROUTES
// ============================================================================

// List trash
app.get('/api/trash', authenticateToken, (req, res) => {
    const trashMetaFile = path.join(CONFIG.TRASH_DIR, '.meta.json');
    if (!fs.existsSync(trashMetaFile)) {
        return res.json([]);
    }

    try {
        const meta = JSON.parse(fs.readFileSync(trashMetaFile, 'utf8'));
        const items = Object.entries(meta).map(([id, data]) => ({
            id,
            ...data,
            exists: fs.existsSync(path.join(CONFIG.TRASH_DIR, id))
        })).filter(item => item.exists);

        res.json(items);
    } catch (e) {
        res.status(500).json({ error: 'Could not read trash' });
    }
});

// Restore from trash
app.post('/api/trash/:id/restore', authenticateToken, (req, res) => {
    const { id } = req.params;
    const trashMetaFile = path.join(CONFIG.TRASH_DIR, '.meta.json');

    if (!fs.existsSync(trashMetaFile)) {
        return res.status(404).json({ error: 'Item not found in trash' });
    }

    try {
        const meta = JSON.parse(fs.readFileSync(trashMetaFile, 'utf8'));
        if (!meta[id]) return res.status(404).json({ error: 'Item not found in trash' });

        const trashPath = path.join(CONFIG.TRASH_DIR, id);
        const originalPath = path.join(CONFIG.UPLOAD_DIR, meta[id].originalPath);

        // Create parent directory if needed
        const parentDir = path.dirname(originalPath);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });

        // Handle name conflicts
        let restorePath = originalPath;
        let counter = 1;
        while (fs.existsSync(restorePath)) {
            const ext = path.extname(meta[id].originalName);
            const name = path.basename(meta[id].originalName, ext);
            restorePath = path.join(parentDir, `${name} (restored ${counter})${ext}`);
            counter++;
        }

        fs.renameSync(trashPath, restorePath);
        const restoredName = meta[id].originalName;
        delete meta[id];
        fs.writeFileSync(trashMetaFile, JSON.stringify(meta, null, 2));

        logActivity('restore', `Restored from trash: ${restoredName}`, req.clientIp, req.user?.username);
        res.json({ message: 'Item restored', path: restorePath });
    } catch (e) {
        res.status(500).json({ error: 'Could not restore item' });
    }
});

// Permanently delete from trash
app.delete('/api/trash/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const trashMetaFile = path.join(CONFIG.TRASH_DIR, '.meta.json');

    try {
        const meta = fs.existsSync(trashMetaFile) ? JSON.parse(fs.readFileSync(trashMetaFile, 'utf8')) : {};
        const trashPath = path.join(CONFIG.TRASH_DIR, id);

        if (fs.existsSync(trashPath)) {
            fs.rmSync(trashPath, { recursive: true, force: true });
        }

        delete meta[id];
        fs.writeFileSync(trashMetaFile, JSON.stringify(meta, null, 2));

        res.json({ message: 'Item permanently deleted' });
    } catch (e) {
        res.status(500).json({ error: 'Could not delete item' });
    }
});

// Empty trash
app.delete('/api/trash', authenticateToken, (req, res) => {
    try {
        const items = fs.readdirSync(CONFIG.TRASH_DIR);
        items.forEach(item => {
            if (item !== '.meta.json') {
                fs.rmSync(path.join(CONFIG.TRASH_DIR, item), { recursive: true, force: true });
            }
        });
        fs.writeFileSync(path.join(CONFIG.TRASH_DIR, '.meta.json'), '{}');
        
        logActivity('empty_trash', 'Emptied trash', req.clientIp, req.user?.username);
        res.json({ message: 'Trash emptied' });
    } catch (e) {
        res.status(500).json({ error: 'Could not empty trash' });
    }
});

// ============================================================================
// FAVORITES ROUTES
// ============================================================================

app.get('/api/favorites', authenticateToken, (req, res) => {
    res.json(favorites);
});

app.post('/api/favorites', authenticateToken, (req, res) => {
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'Path required' });

    if (!favorites.includes(filePath)) {
        favorites.push(filePath);
        saveData(DATA_FILES.favorites, favorites);
    }

    res.json({ message: 'Added to favorites' });
});

app.delete('/api/favorites', authenticateToken, (req, res) => {
    const { path: filePath } = req.body;
    favorites = favorites.filter(f => f !== filePath);
    saveData(DATA_FILES.favorites, favorites);
    res.json({ message: 'Removed from favorites' });
});

// ============================================================================
// RECENT FILES ROUTES
// ============================================================================

app.get('/api/recent', authenticateToken, (req, res) => {
    res.json(recentFiles);
});

app.delete('/api/recent', authenticateToken, (req, res) => {
    recentFiles = [];
    saveData(DATA_FILES.recent, recentFiles);
    res.json({ message: 'Recent files cleared' });
});

// ============================================================================
// TAGS ROUTES
// ============================================================================

app.get('/api/tags', authenticateToken, (req, res) => {
    res.json(tags);
});

app.post('/api/tags', authenticateToken, (req, res) => {
    const { path: filePath, tag } = req.body;
    if (!filePath || !tag) return res.status(400).json({ error: 'Path and tag required' });

    if (!tags[filePath]) tags[filePath] = [];
    if (!tags[filePath].includes(tag)) {
        tags[filePath].push(tag);
        saveData(DATA_FILES.tags, tags);
    }

    res.json({ message: 'Tag added' });
});

app.delete('/api/tags', authenticateToken, (req, res) => {
    const { path: filePath, tag } = req.body;
    if (tags[filePath]) {
        tags[filePath] = tags[filePath].filter(t => t !== tag);
        if (tags[filePath].length === 0) delete tags[filePath];
        saveData(DATA_FILES.tags, tags);
    }
    res.json({ message: 'Tag removed' });
});

// ============================================================================
// SHARE ROUTES
// ============================================================================

// Create share link
app.post('/api/share', authenticateToken, (req, res) => {
    const { path: filePath, password, expiresIn, maxDownloads, uploadOnly } = req.body;
    
    const fullPath = safeResolvePath(filePath);
    if (!fullPath || !fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const shareId = uuidv4().substring(0, 8);
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn).toISOString() : null;

    shares[shareId] = {
        path: filePath,
        password: password ? bcrypt.hashSync(password, 10) : null,
        expiresAt,
        maxDownloads: maxDownloads || null,
        downloadCount: 0,
        uploadOnly: uploadOnly || false,
        createdAt: new Date().toISOString(),
        createdBy: req.user?.username || 'anonymous'
    };

    saveData(DATA_FILES.shares, shares);
    logActivity('share', `Created share link for: ${filePath}`, req.clientIp, req.user?.username);

    const shareUrl = `${req.protocol}://${req.get('host')}/share/${shareId}`;
    res.json({ shareId, shareUrl, expiresAt });
});

// Get share info
app.get('/api/share/:id/info', (req, res) => {
    const { id } = req.params;
    const share = shares[id];

    if (!share) return res.status(404).json({ error: 'Share not found' });
    
    if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
        return res.status(410).json({ error: 'Share link has expired' });
    }

    if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
        return res.status(410).json({ error: 'Download limit reached' });
    }

    const fullPath = safeResolvePath(share.path);
    if (!fullPath || !fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    const stats = fs.statSync(fullPath);

    res.json({
        fileName: path.basename(share.path),
        folderName: path.basename(share.path),
        isFolder: stats.isDirectory(),
        fileSize: stats.isDirectory() ? getDirectorySizeRecursive(fullPath) : stats.size,
        requiresPassword: !!share.password,
        uploadOnly: share.uploadOnly,
        expiresAt: share.expiresAt
    });
});

// Verify share password
app.post('/api/share/:id/verify', (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    const share = shares[id];

    if (!share) return res.status(404).json({ error: 'Share not found' });

    if (share.password && !bcrypt.compareSync(password || '', share.password)) {
        return res.status(401).json({ error: 'Invalid password' });
    }

    const fullPath = safeResolvePath(share.path);
    if (!fullPath || !fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const stats = fs.statSync(fullPath);

    res.json({
        verified: true,
        fileName: path.basename(share.path),
        fileSize: stats.isDirectory() ? getDirectorySizeRecursive(fullPath) : stats.size,
        uploadOnly: share.uploadOnly
    });
});

// Get share info (legacy)
app.get('/api/share/:id', (req, res) => {
    const { id } = req.params;
    const share = shares[id];

    if (!share) return res.status(404).json({ error: 'Share not found' });
    
    if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
        return res.status(410).json({ error: 'Share link has expired' });
    }

    if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
        return res.status(410).json({ error: 'Download limit reached' });
    }

    const fullPath = safeResolvePath(share.path);
    if (!fullPath || !fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    const stats = fs.statSync(fullPath);

    res.json({
        name: path.basename(share.path),
        isFolder: stats.isDirectory(),
        size: stats.isDirectory() ? getDirectorySizeRecursive(fullPath) : stats.size,
        requiresPassword: !!share.password,
        uploadOnly: share.uploadOnly,
        expiresAt: share.expiresAt
    });
});

// Download shared file (GET for direct browser download)
app.get('/api/share/:id/download', (req, res) => {
    const { id } = req.params;
    const { password } = req.query;
    const share = shares[id];

    if (!share) return res.status(404).json({ error: 'Share not found' });
    
    if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
        return res.status(410).json({ error: 'Share link has expired' });
    }

    if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
        return res.status(410).json({ error: 'Download limit reached' });
    }

    if (share.password && !bcrypt.compareSync(password || '', share.password)) {
        return res.status(401).json({ error: 'Invalid password' });
    }

    if (share.uploadOnly) {
        return res.status(403).json({ error: 'This is an upload-only share' });
    }

    const fullPath = safeResolvePath(share.path);
    if (!fullPath || !fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    share.downloadCount++;
    saveData(DATA_FILES.shares, shares);
    logActivity('share_download', `Downloaded via share: ${share.path}`, req.clientIp);

    res.download(fullPath);
});

// Download shared file (POST)
app.post('/api/share/:id/download', (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    const share = shares[id];

    if (!share) return res.status(404).json({ error: 'Share not found' });
    
    if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
        return res.status(410).json({ error: 'Share link has expired' });
    }

    if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
        return res.status(410).json({ error: 'Download limit reached' });
    }

    if (share.password && !bcrypt.compareSync(password || '', share.password)) {
        return res.status(401).json({ error: 'Invalid password' });
    }

    if (share.uploadOnly) {
        return res.status(403).json({ error: 'This is an upload-only share' });
    }

    const fullPath = safeResolvePath(share.path);
    if (!fullPath || !fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    share.downloadCount++;
    saveData(DATA_FILES.shares, shares);
    logActivity('share_download', `Downloaded via share: ${share.path}`, req.clientIp);

    res.download(fullPath);
});

// Upload to shared folder
app.post('/api/share/:id/upload', upload.single('file'), (req, res) => {
    const { id } = req.params;
    const share = shares[id];

    if (!share) return res.status(404).json({ error: 'Share not found' });
    if (!share.uploadOnly) return res.status(403).json({ error: 'Uploads not allowed' });

    const fullPath = safeResolvePath(share.path);
    if (!fullPath || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
        return res.status(400).json({ error: 'Invalid upload destination' });
    }

    logActivity('share_upload', `Uploaded via share: ${req.file.filename}`, req.clientIp);
    res.json({ message: 'File uploaded', filename: req.file.filename });
});

// List shares
app.get('/api/shares', authenticateToken, (req, res) => {
    const shareList = Object.entries(shares).map(([id, data]) => ({
        id,
        ...data,
        url: `${req.protocol}://${req.get('host')}/share/${id}`
    }));
    res.json(shareList);
});

// Delete share
app.delete('/api/share/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    if (shares[id]) {
        delete shares[id];
        saveData(DATA_FILES.shares, shares);
    }
    res.json({ message: 'Share deleted' });
});

// ============================================================================
// QR CODE ROUTE
// ============================================================================

app.get('/api/qr', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    try {
        const qrDataUrl = await QRCode.toDataURL(url, {
            width: 256,
            margin: 2,
            color: { dark: '#8b5cf6', light: '#ffffff' }
        });
        res.json({ qr: qrDataUrl });
    } catch (e) {
        res.status(500).json({ error: 'Could not generate QR code' });
    }
});

// ============================================================================
// ZIP DOWNLOAD ROUTE
// ============================================================================

app.post('/api/download-zip', authenticateToken, (req, res) => {
    const { paths } = req.body;
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
        return res.status(400).json({ error: 'Paths required' });
    }

    const archive = archiver('zip', { zlib: { level: 9 } });

    res.attachment('download.zip');
    archive.pipe(res);

    paths.forEach(p => {
        const fullPath = safeResolvePath(p);
        if (fullPath && fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            if (stats.isDirectory()) {
                archive.directory(fullPath, path.basename(p));
            } else {
                archive.file(fullPath, { name: path.basename(p) });
            }
        }
    });

    archive.finalize();
    logActivity('zip_download', `Downloaded as zip: ${paths.length} items`, req.clientIp, req.user?.username);
});

// ============================================================================
// SEARCH ROUTE
// ============================================================================

app.get('/api/search', authenticateToken, (req, res) => {
    const { q, type, minSize, maxSize, startDate, endDate, tags: searchTags } = req.query;

    function searchDirectory(dir, basePath = '') {
        let results = [];
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (item.startsWith('.')) continue;
                const itemPath = path.join(dir, item);
                const relativePath = path.join(basePath, item);
                const stats = fs.statSync(itemPath);
                const isFolder = stats.isDirectory();
                const fileType = isFolder ? 'folder' : getFileType(item);

                let match = true;

                // Name search
                if (q && !item.toLowerCase().includes(q.toLowerCase())) {
                    match = false;
                }

                // Type filter
                if (type && type !== 'all' && fileType !== type) {
                    match = false;
                }

                // Size filter
                if (!isFolder) {
                    if (minSize && stats.size < parseInt(minSize)) match = false;
                    if (maxSize && stats.size > parseInt(maxSize)) match = false;
                }

                // Date filter
                if (startDate && new Date(stats.mtime) < new Date(startDate)) match = false;
                if (endDate && new Date(stats.mtime) > new Date(endDate)) match = false;

                // Tags filter
                if (searchTags) {
                    const fileTags = tags[relativePath] || [];
                    const requiredTags = searchTags.split(',');
                    if (!requiredTags.some(t => fileTags.includes(t))) match = false;
                }

                if (match) {
                    results.push({
                        name: item,
                        path: relativePath,
                        isFolder,
                        size: isFolder ? getDirectorySizeRecursive(itemPath) : stats.size,
                        date: stats.mtime,
                        type: fileType,
                        tags: tags[relativePath] || []
                    });
                }

                if (isFolder) {
                    results = results.concat(searchDirectory(itemPath, relativePath));
                }
            }
        } catch (e) { }
        return results;
    }

    const results = searchDirectory(CONFIG.UPLOAD_DIR);
    res.json(results);
});

// ============================================================================
// ACTIVITY LOG ROUTES
// ============================================================================

app.get('/api/activity', authenticateToken, (req, res) => {
    const { limit = 100, action, user } = req.query;
    let filtered = activityLog;

    if (action) filtered = filtered.filter(a => a.action === action);
    if (user) filtered = filtered.filter(a => a.user === user);

    res.json(filtered.slice(0, parseInt(limit)));
});

app.delete('/api/activity', authenticateToken, (req, res) => {
    activityLog = [];
    saveData(DATA_FILES.activity, activityLog);
    res.json({ message: 'Activity log cleared' });
});

// ============================================================================
// ADMIN ROUTES
// ============================================================================

// Dashboard stats
app.get('/api/admin/stats', authenticateToken, (req, res) => {
    const totalFiles = countFiles(CONFIG.UPLOAD_DIR);
    const totalSize = getDirectorySizeRecursive(CONFIG.UPLOAD_DIR);
    const trashSize = getDirectorySizeRecursive(CONFIG.TRASH_DIR);

    // System info
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    
    // Get local IP
    const networkInterfaces = os.networkInterfaces();
    let localIp = 'localhost';
    for (const name of Object.keys(networkInterfaces)) {
        for (const iface of networkInterfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIp = iface.address;
                break;
            }
        }
    }
    
    // Process memory (more accurate for app usage)
    const processMemory = process.memoryUsage();

    res.json({
        files: {
            total: totalFiles.files,
            folders: totalFiles.folders,
            totalSize,
            trashSize
        },
        activity: {
            total: activityLog.length,
            today: activityLog.filter(a => new Date(a.timestamp).toDateString() === new Date().toDateString()).length
        },
        shares: Object.keys(shares).length,
        system: {
            platform: os.platform(),
            arch: os.arch(),
            cpuCount: cpus.length,
            cpuModel: cpus[0]?.model,
            totalMemory: totalMem,
            freeMemory: freeMem,
            usedMemoryPercent: ((totalMem - freeMem) / totalMem * 100).toFixed(1),
            processMemory: processMemory.heapUsed,
            uptime: os.uptime(),
            processUptime: process.uptime(),
            nodeVersion: process.version,
            hostname: os.hostname(),
            localIp
        }
    });
});

function countFiles(dir) {
    let files = 0, folders = 0;
    try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            if (item.startsWith('.')) continue;
            const itemPath = path.join(dir, item);
            const stats = fs.statSync(itemPath);
            if (stats.isDirectory()) {
                folders++;
                const sub = countFiles(itemPath);
                files += sub.files;
                folders += sub.folders;
            } else {
                files++;
            }
        }
    } catch (e) { }
    return { files, folders };
}

// IP config
app.get('/api/admin/ip-config', authenticateToken, (req, res) => {
    res.json(ipConfig);
});

app.put('/api/admin/ip-config', authenticateToken, (req, res) => {
    const { mode, whitelist, blacklist } = req.body;
    if (mode) ipConfig.mode = mode;
    if (whitelist) ipConfig.whitelist = whitelist;
    if (blacklist) ipConfig.blacklist = blacklist;
    saveData(DATA_FILES.ipConfig, ipConfig);
    res.json({ message: 'IP config updated', config: ipConfig });
});

// Settings
app.get('/api/admin/settings', authenticateToken, (req, res) => {
    res.json(settings);
});

app.put('/api/admin/settings', authenticateToken, (req, res) => {
    Object.assign(settings, req.body);
    saveData(DATA_FILES.settings, settings);
    res.json({ message: 'Settings updated', settings });
});

// Users management
app.get('/api/admin/users', authenticateToken, (req, res) => {
    const userList = Object.entries(users).map(([username, data]) => ({
        username,
        role: data.role
    }));
    res.json(userList);
});

app.delete('/api/admin/users/:username', authenticateToken, (req, res) => {
    const { username } = req.params;
    if (username === 'admin') {
        return res.status(400).json({ error: 'Cannot delete admin user' });
    }
    if (users[username]) {
        delete users[username];
        saveData(DATA_FILES.users, users);
    }
    res.json({ message: 'User deleted' });
});

// Large files cleanup helper
app.get('/api/admin/large-files', authenticateToken, (req, res) => {
    const { minSize = 100 * 1024 * 1024 } = req.query; // Default 100MB

    function findLargeFiles(dir, basePath = '') {
        let results = [];
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (item.startsWith('.')) continue;
                const itemPath = path.join(dir, item);
                const relativePath = path.join(basePath, item);
                const stats = fs.statSync(itemPath);

                if (stats.isDirectory()) {
                    results = results.concat(findLargeFiles(itemPath, relativePath));
                } else if (stats.size >= parseInt(minSize)) {
                    results.push({
                        name: item,
                        path: relativePath,
                        size: stats.size,
                        date: stats.mtime
                    });
                }
            }
        } catch (e) { }
        return results;
    }

    const files = findLargeFiles(CONFIG.UPLOAD_DIR);
    files.sort((a, b) => b.size - a.size);
    res.json(files);
});

// Activity log
app.get('/api/admin/activity', authenticateToken, (req, res) => {
    res.json(activityLog.slice().reverse());
});

app.delete('/api/admin/activity', authenticateToken, (req, res) => {
    activityLog = [];
    saveData(DATA_FILES.activity, activityLog);
    res.json({ message: 'Activity log cleared' });
});

// Change admin password
app.post('/api/admin/change-password', authenticateToken, (req, res) => {
    const { password } = req.body;
    
    if (!password || password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    users.admin.password = bcrypt.hashSync(password, 10);
    saveData(DATA_FILES.users, users);
    logActivity('settings', 'Admin password changed', req.clientIp, req.user?.username);
    
    res.json({ message: 'Password changed successfully' });
});

// Cleanup expired shares
app.post('/api/admin/cleanup-shares', authenticateToken, (req, res) => {
    const now = new Date();
    let cleaned = 0;
    
    Object.keys(shares).forEach(id => {
        const share = shares[id];
        if (share.expiresAt && new Date(share.expiresAt) < now) {
            delete shares[id];
            cleaned++;
        }
        if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
            delete shares[id];
            cleaned++;
        }
    });
    
    saveData(DATA_FILES.shares, shares);
    logActivity('cleanup', `Cleaned ${cleaned} expired shares`, req.clientIp, req.user?.username);
    
    res.json({ cleaned });
});

// Admin shares list
app.get('/api/admin/shares', authenticateToken, (req, res) => {
    const shareList = Object.entries(shares).map(([id, share]) => ({
        id,
        ...share
    }));
    res.json(shareList);
});

// IP Whitelist management
app.post('/api/admin/ip/whitelist', authenticateToken, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP required' });
    
    if (!settings.ipWhitelist) settings.ipWhitelist = [];
    if (!settings.ipWhitelist.includes(ip)) {
        settings.ipWhitelist.push(ip);
        saveData(DATA_FILES.settings, settings);
        logActivity('settings', `Added ${ip} to whitelist`, req.clientIp, req.user?.username);
    }
    res.json({ message: 'IP added to whitelist' });
});

app.delete('/api/admin/ip/whitelist', authenticateToken, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP required' });
    
    if (settings.ipWhitelist) {
        settings.ipWhitelist = settings.ipWhitelist.filter(i => i !== ip);
        saveData(DATA_FILES.settings, settings);
        logActivity('settings', `Removed ${ip} from whitelist`, req.clientIp, req.user?.username);
    }
    res.json({ message: 'IP removed from whitelist' });
});

// IP Blacklist management
app.post('/api/admin/ip/blacklist', authenticateToken, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP required' });
    
    if (!settings.ipBlacklist) settings.ipBlacklist = [];
    if (!settings.ipBlacklist.includes(ip)) {
        settings.ipBlacklist.push(ip);
        saveData(DATA_FILES.settings, settings);
        logActivity('settings', `Added ${ip} to blacklist`, req.clientIp, req.user?.username);
    }
    res.json({ message: 'IP added to blacklist' });
});

app.delete('/api/admin/ip/blacklist', authenticateToken, (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP required' });
    
    if (settings.ipBlacklist) {
        settings.ipBlacklist = settings.ipBlacklist.filter(i => i !== ip);
        saveData(DATA_FILES.settings, settings);
        logActivity('settings', `Removed ${ip} from blacklist`, req.clientIp, req.user?.username);
    }
    res.json({ message: 'IP removed from blacklist' });
});

// ============================================================================
// STORAGE LOCATIONS MANAGEMENT
// ============================================================================

// Get all storage locations
app.get('/api/admin/storage-locations', authenticateToken, (req, res) => {
    // Add disk info for each location
    const locationsWithInfo = storageLocations.map(loc => {
        let diskInfo = { total: 0, free: 0, used: 0 };
        try {
            if (fs.existsSync(loc.path)) {
                // Get disk usage for the path
                const stats = fs.statfsSync ? fs.statfsSync(loc.path) : null;
                if (stats) {
                    diskInfo.total = stats.blocks * stats.bsize;
                    diskInfo.free = stats.bfree * stats.bsize;
                    diskInfo.used = diskInfo.total - diskInfo.free;
                }
                // Calculate used space in this location
                diskInfo.usedByBlackDrop = getDirectorySizeRecursive(loc.path);
            }
        } catch (e) {
            console.error('Error getting disk info:', e);
        }
        return { ...loc, diskInfo };
    });
    res.json(locationsWithInfo);
});

// Add new storage location
app.post('/api/admin/storage-locations', authenticateToken, (req, res) => {
    const { name, path: locationPath } = req.body;
    
    if (!name || !locationPath) {
        return res.status(400).json({ error: 'Name and path are required' });
    }
    
    // Validate path exists or can be created
    const resolvedPath = path.resolve(locationPath);
    
    try {
        if (!fs.existsSync(resolvedPath)) {
            fs.mkdirSync(resolvedPath, { recursive: true });
        }
        
        // Check if path is already added
        if (storageLocations.some(loc => loc.path === resolvedPath)) {
            return res.status(400).json({ error: 'This path is already added' });
        }
        
        const newLocation = {
            id: uuidv4(),
            name,
            path: resolvedPath,
            enabled: true,
            isDefault: false,
            addedAt: new Date().toISOString()
        };
        
        storageLocations.push(newLocation);
        saveData(DATA_FILES.storageLocations, storageLocations);
        logActivity('storage', `Added storage location: ${name} (${resolvedPath})`, req.clientIp, req.user?.username);
        
        res.json({ message: 'Storage location added', location: newLocation });
    } catch (e) {
        res.status(500).json({ error: 'Could not create/access path: ' + e.message });
    }
});

// Update storage location (enable/disable, set default)
app.put('/api/admin/storage-locations/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { enabled, isDefault, name } = req.body;
    
    const location = storageLocations.find(loc => loc.id === id);
    if (!location) {
        return res.status(404).json({ error: 'Storage location not found' });
    }
    
    if (typeof enabled !== 'undefined') {
        // Cannot disable default location
        if (!enabled && location.isDefault) {
            return res.status(400).json({ error: 'Cannot disable the default storage location' });
        }
        location.enabled = enabled;
    }
    
    if (isDefault) {
        // Set this as default, unset others
        storageLocations.forEach(loc => loc.isDefault = false);
        location.isDefault = true;
        location.enabled = true; // Default must be enabled
        // Update CONFIG.UPLOAD_DIR
        CONFIG.UPLOAD_DIR = location.path;
    }
    
    if (name) {
        location.name = name;
    }
    
    saveData(DATA_FILES.storageLocations, storageLocations);
    logActivity('storage', `Updated storage location: ${location.name}`, req.clientIp, req.user?.username);
    
    res.json({ message: 'Storage location updated', location });
});

// Delete storage location
app.delete('/api/admin/storage-locations/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    
    const location = storageLocations.find(loc => loc.id === id);
    if (!location) {
        return res.status(404).json({ error: 'Storage location not found' });
    }
    
    if (location.isDefault) {
        return res.status(400).json({ error: 'Cannot delete the default storage location' });
    }
    
    storageLocations = storageLocations.filter(loc => loc.id !== id);
    saveData(DATA_FILES.storageLocations, storageLocations);
    logActivity('storage', `Removed storage location: ${location.name}`, req.clientIp, req.user?.username);
    
    res.json({ message: 'Storage location removed' });
});

// Get active storage location for uploads
app.get('/api/storage-location', (req, res) => {
    const activeLocations = storageLocations.filter(loc => loc.enabled);
    const defaultLocation = storageLocations.find(loc => loc.isDefault) || activeLocations[0];
    res.json({ 
        locations: activeLocations,
        default: defaultLocation
    });
});

// ============================================================================
// FILE PREVIEW ROUTES
// ============================================================================

// Read file content (for code/markdown preview)
app.get('/api/preview/:filename(*)', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    const parentPath = req.query.parentPath || '';
    const filePath = safeResolvePath(path.join(parentPath, filename));

    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const stats = fs.statSync(filePath);
    if (stats.size > 5 * 1024 * 1024) { // 5MB limit for preview
        return res.status(400).json({ error: 'File too large for preview' });
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        addToRecent(path.join(parentPath, filename), 'previewed');
        res.json({ content, type: getFileType(filename) });
    } catch (e) {
        res.status(500).json({ error: 'Could not read file' });
    }
});

// Save file content (for editing markdown/code files)
app.put('/api/preview/:filename(*)', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    const parentPath = req.query.parentPath || '';
    const { content } = req.body;
    const filePath = safeResolvePath(path.join(parentPath, filename));

    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    if (typeof content !== 'string') {
        return res.status(400).json({ error: 'Content is required' });
    }

    try {
        fs.writeFileSync(filePath, content, 'utf8');
        logActivity('edit', `Edited: ${filename}`, req.clientIp, req.user?.username);
        res.json({ message: 'File saved', type: getFileType(filename) });
    } catch (e) {
        res.status(500).json({ error: 'Could not save file' });
    }
});

// ============================================================================
// LEGACY ROUTES (backwards compatibility)
// ============================================================================

app.post('/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const parentPath = req.uploadParentPath || '';
    const fileData = {
        name: req.file.filename,
        size: req.file.size,
        date: new Date(),
        type: getFileType(req.file.filename),
        isFolder: false
    };
    io.emit('file:uploaded', { file: fileData, parentPath: parentPath || '/' });
    logActivity('upload', `Uploaded: ${req.file.filename}`, req.clientIp, req.user?.username);
    res.json({ message: 'File uploaded successfully', filename: req.file.filename, parentPath });
});

app.get('/files', authenticateToken, (req, res) => {
    fs.readdir(CONFIG.UPLOAD_DIR, (err, files) => {
        if (err) return res.status(500).json({ error: 'Unable to scan files' });
        const fileList = files.filter(f => !f.startsWith('.')).map(file => {
            const filePath = path.join(CONFIG.UPLOAD_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                if (!stats.isFile()) return null;
                return { name: file, size: stats.size, date: stats.mtime, type: getFileType(file) };
            } catch (e) { return null; }
        }).filter(Boolean);
        fileList.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json(fileList);
    });
});

app.get('/contents', authenticateToken, (req, res) => {
    const folderPath = safeResolvePath(req.query.path || '');
    if (!folderPath || !fs.existsSync(folderPath)) {
        return res.status(404).json({ error: 'Folder not found' });
    }
    try {
        const items = fs.readdirSync(folderPath);
        const contents = items.filter(item => !item.startsWith('.')).map(item => {
            const itemPath = path.join(folderPath, item);
            try {
                const stats = fs.statSync(itemPath);
                const isFolder = stats.isDirectory();
                return {
                    name: item, isFolder,
                    size: isFolder ? getDirectorySizeRecursive(itemPath) : stats.size,
                    date: stats.mtime,
                    type: isFolder ? 'folder' : getFileType(item),
                    itemCount: isFolder ? fs.readdirSync(itemPath).filter(f => !f.startsWith('.')).length : 0
                };
            } catch (e) { return null; }
        }).filter(Boolean);
        contents.sort((a, b) => {
            if (a.isFolder && !b.isFolder) return -1;
            if (!a.isFolder && b.isFolder) return 1;
            return new Date(b.date) - new Date(a.date);
        });
        res.json(contents);
    } catch (e) {
        res.status(500).json({ error: 'Unable to read folder' });
    }
});

app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(CONFIG.UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) {
        logActivity('download', `Downloaded: ${filename}`, getClientIp(req));
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

app.delete('/files/:filename', authenticateToken, (req, res) => {
    const filename = req.params.filename;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(CONFIG.UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
            io.emit('file:deleted', { name: filename });
            logActivity('delete', `Deleted: ${filename}`, req.clientIp, req.user?.username);
            res.json({ message: 'File deleted' });
        } catch (e) {
            res.status(500).json({ error: 'Could not delete file' });
        }
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

app.put('/files/:filename', authenticateToken, (req, res) => {
    const oldName = req.params.filename;
    const { newName } = req.body;
    if (!newName) return res.status(400).json({ error: 'New name is required' });
    if (oldName.includes('..') || newName.includes('..')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const oldPath = path.join(CONFIG.UPLOAD_DIR, oldName);
    const newPath = path.join(CONFIG.UPLOAD_DIR, newName);
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'File not found' });
    if (fs.existsSync(newPath)) return res.status(400).json({ error: 'A file with this name already exists' });
    try {
        fs.renameSync(oldPath, newPath);
        io.emit('file:renamed', { oldName, newName });
        logActivity('rename', `Renamed: ${oldName} → ${newName}`, req.clientIp, req.user?.username);
        res.json({ message: 'File renamed', oldName, newName });
    } catch (e) {
        res.status(500).json({ error: 'Could not rename file' });
    }
});

app.get('/storage', (req, res) => {
    const used = getDirectorySizeRecursive(CONFIG.UPLOAD_DIR);
    res.json({ used, total: CONFIG.TOTAL_QUOTA, free: CONFIG.TOTAL_QUOTA - used });
});

app.post('/folders', authenticateToken, (req, res) => {
    const { name, parentPath } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        return res.status(400).json({ error: 'Invalid folder name' });
    }
    const parentDir = safeResolvePath(parentPath || '');
    if (!parentDir) return res.status(400).json({ error: 'Invalid parent path' });
    const newFolderPath = path.join(parentDir, name);
    if (fs.existsSync(newFolderPath)) return res.status(400).json({ error: 'A folder with this name already exists' });
    try {
        fs.mkdirSync(newFolderPath, { recursive: true });
        const stats = fs.statSync(newFolderPath);
        const folderData = { name, isFolder: true, size: 0, date: stats.mtime, type: 'folder', itemCount: 0 };
        io.emit('folder:created', { folder: folderData, parentPath: parentPath || '/' });
        logActivity('create_folder', `Created folder: ${name}`, req.clientIp, req.user?.username);
        res.json({ message: 'Folder created', folder: folderData });
    } catch (e) {
        res.status(500).json({ error: 'Could not create folder' });
    }
});

app.delete('/folders/*', authenticateToken, (req, res) => {
    const folderRelPath = req.params[0];
    const folderPath = safeResolvePath(folderRelPath);
    if (!folderPath || folderPath === CONFIG.UPLOAD_DIR) return res.status(400).json({ error: 'Invalid folder path' });
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'Folder not found' });
    try {
        fs.rmSync(folderPath, { recursive: true, force: true });
        io.emit('folder:deleted', { path: folderRelPath });
        logActivity('delete', `Deleted folder: ${folderRelPath}`, req.clientIp, req.user?.username);
        res.json({ message: 'Folder deleted' });
    } catch (e) {
        res.status(500).json({ error: 'Could not delete folder' });
    }
});

app.post('/move', authenticateToken, (req, res) => {
    const { source, destination, name } = req.body;
    const sourcePath = safeResolvePath(source);
    const destDir = safeResolvePath(destination || '');
    if (!sourcePath || !destDir) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(sourcePath)) return res.status(404).json({ error: 'Source not found' });
    const itemName = name || path.basename(sourcePath);
    const destPath = path.join(destDir, itemName);
    if (fs.existsSync(destPath)) return res.status(400).json({ error: 'An item with this name already exists at destination' });
    try {
        fs.renameSync(sourcePath, destPath);
        io.emit('item:moved', { source, destination, name: itemName });
        logActivity('move', `Moved: ${source} → ${destination}/${itemName}`, req.clientIp, req.user?.username);
        res.json({ message: 'Item moved' });
    } catch (e) {
        res.status(500).json({ error: 'Could not move item' });
    }
});

// ============================================================================
// SHARE PAGE ROUTE
// ============================================================================

app.get('/share/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// ============================================================================
// START SERVER
// ============================================================================

function getLocalIp() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'localhost';
}

server.listen(CONFIG.PORT, '0.0.0.0', () => {
    const ip = getLocalIp();
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                                                               ║');
    console.log('║   ██████╗ ██╗      █████╗  ██████╗██╗  ██╗                    ║');
    console.log('║   ██╔══██╗██║     ██╔══██╗██╔════╝██║ ██╔╝                    ║');
    console.log('║   ██████╔╝██║     ███████║██║     █████╔╝                     ║');
    console.log('║   ██╔══██╗██║     ██╔══██║██║     ██╔═██╗                     ║');
    console.log('║   ██████╔╝███████╗██║  ██║╚██████╗██║  ██╗                    ║');
    console.log('║   ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝                    ║');
    console.log('║   ██████╗ ██████╗  ██████╗ ██████╗     ██████╗ ██████╗  ██████╗║');
    console.log('║   ██╔══██╗██╔══██╗██╔═══██╗██╔══██╗    ██╔══██╗██╔══██╗██╔═══██╗');
    console.log('║   ██║  ██║██████╔╝██║   ██║██████╔╝    ██████╔╝██████╔╝██║   ██║');
    console.log('║   ██║  ██║██╔══██╗██║   ██║██╔═══╝     ██╔═══╝ ██╔══██╗██║   ██║');
    console.log('║   ██████╔╝██║  ██║╚██████╔╝██║         ██║     ██║  ██║╚██████╔╝');
    console.log('║   ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝         ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ');
    console.log('║                                                               ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log('║                                                               ║');
    console.log(`║   🌐 Local:    https://localhost:${CONFIG.PORT}                      ║`);
    console.log(`║   📡 Network:  https://${ip}:${CONFIG.PORT}`.padEnd(64) + '║');
    console.log('║                                                               ║');
    console.log('║   🔐 Auth:     ' + (settings.authEnabled ? 'Enabled (admin/admin)' : 'Disabled').padEnd(44) + '║');
    console.log('║   💡 Tip:      Use Ctrl+C to stop the server                  ║');
    console.log('║                                                               ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');
});
