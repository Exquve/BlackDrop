const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Server } = require("socket.io");
const os = require('os');

const app = express();

// Load SSL Certificates
const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem'))
};

const server = https.createServer(sslOptions, app);
const io = new Server(server);

const PORT = 3000;

// Helper to get client IP
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] ||
        req.connection?.remoteAddress ||
        req.socket?.remoteAddress ||
        req.ip ||
        'unknown';
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
    req.clientIp = getClientIp(req).replace('::ffff:', '');
    next();
});

// Socket.io Connection
io.on('connection', (socket) => {
    const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0] ||
        socket.handshake.address?.replace('::ffff:', '') ||
        'unknown';
    console.log(`🟢 ${ip} connected`);

    socket.on('disconnect', () => {
        console.log(`🔴 ${ip} disconnected`);
    });
});

// Configure Multer for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Support uploading to subfolders
        const parentPath = (req.query.parentPath || '').replace(/^\/+/, '').replace(/\.\./g, '');
        const targetDir = path.join(uploadDir, parentPath);

        // Create directory if it doesn't exist
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // Store the parent path for later use
        req.uploadParentPath = parentPath;
        cb(null, targetDir);
    },
    filename: (req, file, cb) => {
        const parentPath = (req.query.parentPath || '').replace(/^\/+/, '').replace(/\.\./g, '');
        const targetDir = path.join(uploadDir, parentPath);

        // Handle duplicate filenames
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
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 * 1024 // 10GB limit
    }
});

// Helper to get file Type
function getFileType(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(ext)) return 'image';
    if (['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.m4v'].includes(ext)) return 'video';
    if (['.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.md', '.rtf', '.odt', '.json', '.xml'].includes(ext)) return 'document';
    if (['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'].includes(ext)) return 'audio';
    if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'].includes(ext)) return 'archive';
    return 'other';
}

// Helper to get directory size
function getDirectorySize(dirPath) {
    let totalSize = 0;
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
                totalSize += stats.size;
            }
        }
    } catch (e) {
        console.error('Error calculating directory size:', e);
    }
    return totalSize;
}

// Routes

// 1. Upload File
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const parentPath = req.uploadParentPath || '';
    const fileData = {
        name: req.file.filename,
        size: req.file.size,
        date: new Date(),
        type: getFileType(req.file.filename),
        isFolder: false
    };

    // Emit real-time event with parent path
    io.emit('file:uploaded', { file: fileData, parentPath: parentPath || '/' });

    console.log(`📤 ${req.clientIp} uploaded: ${parentPath ? parentPath + '/' : ''}${req.file.filename} (${formatBytes(req.file.size)})`);
    res.json({ message: 'File uploaded successfully', filename: req.file.filename, parentPath: parentPath });
});

// 2. List Files
app.get('/files', (req, res) => {
    fs.readdir(uploadDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: 'Unable to scan files' });
        }

        const fileList = files
            .filter(file => !file.startsWith('.')) // Hide hidden files
            .map(file => {
                const filePath = path.join(uploadDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    if (!stats.isFile()) return null;
                    return {
                        name: file,
                        size: stats.size,
                        date: stats.mtime,
                        type: getFileType(file)
                    };
                } catch (e) {
                    return null;
                }
            })
            .filter(item => item !== null);

        // Sort by date (newest first)
        fileList.sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json(fileList);
    });
});

// 3. Download File
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;

    // Prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }

    const filePath = path.join(uploadDir, filename);

    if (fs.existsSync(filePath)) {
        console.log(`📥 ${req.clientIp} downloaded: ${filename}`);
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// 4. Delete File
app.delete('/files/:filename', (req, res) => {
    const filename = req.params.filename;

    // Prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }

    const filePath = path.join(uploadDir, filename);

    if (fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
            io.emit('file:deleted', { name: filename });
            console.log(`🗑️  ${req.clientIp} deleted: ${filename}`);
            res.json({ message: 'File deleted' });
        } catch (e) {
            res.status(500).json({ error: 'Could not delete file' });
        }
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// 5. Rename File
app.put('/files/:filename', (req, res) => {
    const oldName = req.params.filename;
    const { newName } = req.body;

    // Validate
    if (!newName || typeof newName !== 'string') {
        return res.status(400).json({ error: 'New name is required' });
    }

    // Prevent directory traversal
    if (oldName.includes('..') || oldName.includes('/') || oldName.includes('\\') ||
        newName.includes('..') || newName.includes('/') || newName.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }

    const oldPath = path.join(uploadDir, oldName);
    const newPath = path.join(uploadDir, newName);

    if (!fs.existsSync(oldPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    if (fs.existsSync(newPath)) {
        return res.status(400).json({ error: 'A file with this name already exists' });
    }

    try {
        fs.renameSync(oldPath, newPath);
        io.emit('file:renamed', { oldName, newName });
        console.log(`✏️  ${req.clientIp} renamed: ${oldName} → ${newName}`);
        res.json({ message: 'File renamed', oldName, newName });
    } catch (e) {
        res.status(500).json({ error: 'Could not rename file' });
    }
});

// 6. Storage Info
app.get('/storage', (req, res) => {
    const used = getDirectorySizeRecursive(uploadDir);

    // Get disk info - use a reasonable default for total storage display
    // In a real app, you might want to set a quota
    const totalQuota = 10 * 1024 * 1024 * 1024; // 10GB default quota

    res.json({
        used: used,
        total: totalQuota,
        free: totalQuota - used
    });
});

// Helper to get directory size recursively
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
    } catch (e) {
        console.error('Error calculating directory size:', e);
    }
    return totalSize;
}

// Helper to safely resolve path within uploads directory
function safeResolvePath(relativePath) {
    // Normalize and remove leading slashes
    const cleanPath = (relativePath || '').replace(/^\/+/, '').replace(/\.\./g, '');
    const resolved = path.join(uploadDir, cleanPath);

    // Ensure the resolved path is within uploadDir
    if (!resolved.startsWith(uploadDir)) {
        return null;
    }
    return resolved;
}

// 7. List Folder Contents
app.get('/contents', (req, res) => {
    const folderPath = safeResolvePath(req.query.path || '');

    if (!folderPath) {
        return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(folderPath)) {
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
                    return {
                        name: item,
                        isFolder: isFolder,
                        size: isFolder ? getDirectorySizeRecursive(itemPath) : stats.size,
                        date: stats.mtime,
                        type: isFolder ? 'folder' : getFileType(item),
                        itemCount: isFolder ? fs.readdirSync(itemPath).filter(f => !f.startsWith('.')).length : 0
                    };
                } catch (e) {
                    return null;
                }
            })
            .filter(item => item !== null);

        // Sort: folders first, then by date
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

// 8. Create Folder
app.post('/folders', (req, res) => {
    const { name, parentPath } = req.body;

    if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'Folder name is required' });
    }

    // Validate folder name
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        return res.status(400).json({ error: 'Invalid folder name' });
    }

    const parentDir = safeResolvePath(parentPath || '');
    if (!parentDir) {
        return res.status(400).json({ error: 'Invalid parent path' });
    }

    const newFolderPath = path.join(parentDir, name);

    if (fs.existsSync(newFolderPath)) {
        return res.status(400).json({ error: 'A folder with this name already exists' });
    }

    try {
        fs.mkdirSync(newFolderPath, { recursive: true });

        const stats = fs.statSync(newFolderPath);
        const folderData = {
            name: name,
            isFolder: true,
            size: 0,
            date: stats.mtime,
            type: 'folder',
            itemCount: 0
        };

        io.emit('folder:created', { folder: folderData, parentPath: parentPath || '/' });
        console.log(`📁 ${req.clientIp} created folder: ${name}`);
        res.json({ message: 'Folder created', folder: folderData });
    } catch (e) {
        res.status(500).json({ error: 'Could not create folder' });
    }
});

// 9. Delete Folder
app.delete('/folders/*', (req, res) => {
    const folderRelPath = req.params[0];
    const folderPath = safeResolvePath(folderRelPath);

    if (!folderPath || folderPath === uploadDir) {
        return res.status(400).json({ error: 'Invalid folder path' });
    }

    if (!fs.existsSync(folderPath)) {
        return res.status(404).json({ error: 'Folder not found' });
    }

    try {
        fs.rmSync(folderPath, { recursive: true, force: true });
        io.emit('folder:deleted', { path: folderRelPath });
        console.log(`🗑️  ${req.clientIp} deleted folder: ${folderRelPath}`);
        res.json({ message: 'Folder deleted' });
    } catch (e) {
        res.status(500).json({ error: 'Could not delete folder' });
    }
});

// 10. Move Item (file or folder)
app.post('/move', (req, res) => {
    const { source, destination, name } = req.body;

    const sourcePath = safeResolvePath(source);
    const destDir = safeResolvePath(destination || '');

    if (!sourcePath || !destDir) {
        return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(sourcePath)) {
        return res.status(404).json({ error: 'Source not found' });
    }

    const itemName = name || path.basename(sourcePath);
    const destPath = path.join(destDir, itemName);

    if (fs.existsSync(destPath)) {
        return res.status(400).json({ error: 'An item with this name already exists at destination' });
    }

    try {
        fs.renameSync(sourcePath, destPath);
        io.emit('item:moved', { source, destination, name: itemName });
        console.log(`📦 ${req.clientIp} moved: ${source} → ${destination}/${itemName}`);
        res.json({ message: 'Item moved' });
    } catch (e) {
        res.status(500).json({ error: 'Could not move item' });
    }
});

// Helper function for logging
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Get local IP
const { networkInterfaces } = require('os');
const nets = networkInterfaces();

function getLocalIp() {
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIp();
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║                                                       ║');
    console.log('║   ██████╗ ██╗      █████╗  ██████╗██╗  ██╗            ║');
    console.log('║   ██╔══██╗██║     ██╔══██╗██╔════╝██║ ██╔╝            ║');
    console.log('║   ██████╔╝██║     ███████║██║     █████╔╝             ║');
    console.log('║   ██╔══██╗██║     ██╔══██║██║     ██╔═██╗             ║');
    console.log('║   ██████╔╝███████╗██║  ██║╚██████╗██║  ██╗            ║');
    console.log('║   ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝            ║');
    console.log('║   ██████╗ ██████╗  ██████╗ ██████╗                    ║');
    console.log('║   ██╔══██╗██╔══██╗██╔═══██╗██╔══██╗                   ║');
    console.log('║   ██║  ██║██████╔╝██║   ██║██████╔╝                   ║');
    console.log('║   ██║  ██║██╔══██╗██║   ██║██╔═══╝                    ║');
    console.log('║   ██████╔╝██║  ██║╚██████╔╝██║                        ║');
    console.log('║   ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝                        ║');
    console.log('║                                                       ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log('║                                                       ║');
    console.log(`║   🌐 Local:   https://localhost:${PORT}                  ║`);
    console.log(`║   📡 Network: https://${ip}:${PORT}`.padEnd(56) + '║');
    console.log('║                                                       ║');
    console.log('║   💡 Tip: Use Ctrl+C to stop the server               ║');
    console.log('║                                                       ║');
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log('');
});
