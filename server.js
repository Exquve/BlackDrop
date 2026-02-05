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
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Handle duplicate filenames
        let filename = file.originalname;
        let filePath = path.join(uploadDir, filename);
        let counter = 1;

        while (fs.existsSync(filePath)) {
            const ext = path.extname(file.originalname);
            const name = path.basename(file.originalname, ext);
            filename = `${name} (${counter})${ext}`;
            filePath = path.join(uploadDir, filename);
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

    const fileData = {
        name: req.file.filename,
        size: req.file.size,
        date: new Date(),
        type: getFileType(req.file.filename)
    };

    // Emit real-time event
    io.emit('file:uploaded', fileData);

    console.log(`📤 ${req.clientIp} uploaded: ${req.file.filename} (${formatBytes(req.file.size)})`);
    res.json({ message: 'File uploaded successfully', filename: req.file.filename });
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
    const used = getDirectorySize(uploadDir);

    // Get disk info - use a reasonable default for total storage display
    // In a real app, you might want to set a quota
    const totalQuota = 10 * 1024 * 1024 * 1024; // 10GB default quota

    res.json({
        used: used,
        total: totalQuota,
        free: totalQuota - used
    });
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
