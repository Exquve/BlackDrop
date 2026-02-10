# BlackDrop

Self-hosted file sharing and management platform for local networks. Secure, real-time, multi-user.

![BlackDrop](https://img.shields.io/badge/BlackDrop-v1.0.0-8b5cf6?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

## Features

### File Management
- **Drag & Drop Upload** with queue system (sequential uploads, per-file progress tracking)
- **Folder Support** - Create folders, navigate nested directory structures
- **File Preview** - Images, videos, audio, PDF, code files with syntax highlighting, Markdown rendering
- **Universal Editor** - Edit text files, code, and documents directly in browser with auto-save
- **File Versioning** - Automatic version history on each save, restore previous versions
- **Bulk Operations** - Multi-select with Ctrl/Shift+Click, batch download/move/delete
- **ZIP Download** - Download multiple files or entire folders as ZIP archive
- **Context Menu** - Right-click for file operations (rename, move, copy, delete, share, properties)
- **Clipboard Paste** - Paste images and files directly from clipboard (Ctrl+V)
- **Smart Search** - Search by filename, type, tags with search history

### Storage & Organization
- **Multiple Storage Locations** - Add external disks, NAS, or extra folders as storage backends
- **Per-user Home Directories** - Each user gets their own isolated storage space
- **Favorites** - Star frequently accessed files
- **Tags** - Organize files with custom color-coded tags
- **File Comments** - Add comments/notes to any file
- **Trash / Recycle Bin** - Deleted files go to trash, auto-cleanup after 30 days

### Security & Integrity
- **HTTPS** - Self-signed SSL certificates (auto-generated)
- **JWT Authentication** - Token-based auth with 7-day expiry
- **Role-Based Access Control (RBAC)** - Three roles: SuperAdmin, Admin, User
- **Per-file Access Control** - Restrict specific files/folders to specific users
- **File Integrity (SHA-256)** - Checksums auto-computed on upload, verify integrity on demand
- **IP Whitelist/Blacklist** - Restrict access by IP address
- **Rate Limiting** - Protect against brute-force attacks
- **Helmet & Security Headers** - HTTP security best practices

### Sharing
- **Share Links** - Generate shareable links with optional password and expiration
- **QR Codes** - Auto-generated QR code for each share link
- **Download Counting** - Track how many times shared files are downloaded

### Real-time & Notifications
- **Real-time Sync** - File changes broadcast instantly via Socket.io
- **Notification System** - In-app + browser notifications for downloads, shares, and system events
- **Activity Log** - Full audit trail of all file operations

### UI & UX
- **Glassmorphism Design** - Modern UI with blur effects and smooth animations
- **Dark/Light Theme** - Toggle between themes
- **Grid/List View** - Switch between grid and list layouts
- **Multi-language (i18n)** - Turkish and English support
- **Keyboard Shortcuts** - Power-user navigation
- **Responsive Design** - Works on desktop and mobile browsers

### Admin Panel
- **Dashboard** - Overview of storage usage, user count, activity stats
- **User Management** - Create, edit, delete users; assign roles and file permissions
- **Storage Management** - Monitor disk usage, manage storage locations, set default storage
- **System Settings** - Enable/disable auth, notifications, manage IP rules
- **Activity Monitoring** - View all system activity with filtering

---

## Installation

### Prerequisites

- Node.js 18+ and npm
- (Optional) Docker and Docker Compose

### Option 1: npm

```bash
# Clone the repository
git clone https://github.com/Exquve/BlackDrop.git
cd BlackDrop

# Install dependencies
npm install

# Generate SSL certificates
mkdir -p certs
openssl req -x509 -newkey rsa:4096 \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -days 365 -nodes \
  -subj "/CN=localhost"

# Start the server
npm start
```

### Option 2: Docker

```bash
# Clone the repository
git clone https://github.com/Exquve/BlackDrop.git
cd BlackDrop

# Build and start with Docker Compose
docker compose up -d
```

SSL certificates are auto-generated inside the container.

#### Docker Compose with custom settings

```yaml
version: '3.8'

services:
  blackdrop:
    build: .
    container_name: blackdrop
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - blackdrop-uploads:/app/uploads
      - blackdrop-trash:/app/.trash
      - blackdrop-data:/app/.data
      - blackdrop-certs:/app/certs
      # Mount an external drive (optional):
      # - /Volumes/ExternalDisk/files:/mnt/external
    environment:
      - NODE_ENV=production
      - JWT_SECRET=your-secret-key-here
      - BLACKDROP_PORT=3000
      - BLACKDROP_QUOTA=10737418240  # 10GB in bytes

volumes:
  blackdrop-uploads:
  blackdrop-trash:
  blackdrop-data:
  blackdrop-certs:
```

### Access

- **Local:** https://localhost:3000
- **Network:** https://YOUR_LAN_IP:3000

> You'll see a browser security warning for the self-signed certificate. Click "Advanced" then "Proceed" to continue.

### Default Credentials

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin` | SuperAdmin |

Change the password immediately after first login.

---

## Configuration

All configuration is in `server.js` under the `CONFIG` object:

| Setting | Default | Description |
|---------|---------|-------------|
| `PORT` | `3000` | Server port |
| `JWT_SECRET` | Auto-generated | Secret for signing JWT tokens |
| `JWT_EXPIRES_IN` | `7d` | Token expiry duration |
| `TOTAL_QUOTA` | `10 GB` | Maximum storage quota |
| `MAX_FILE_SIZE` | `10 GB` | Maximum single file size |
| `SHARE_LINK_EXPIRY` | `7 days` | Default share link expiration |
| `TRASH_AUTO_DELETE` | `30 days` | Auto-delete trashed files after this period |
| `RATE_LIMIT_WINDOW` | `15 min` | Rate limiting time window |
| `RATE_LIMIT_MAX` | `100` | Max requests per rate limit window |

Environment variables override defaults:

```bash
JWT_SECRET=my-secret-key npm start
```

---

## User Roles

| Permission | SuperAdmin | Admin | User |
|------------|:----------:|:-----:|:----:|
| Upload / Download / Preview | Yes | Yes | Yes |
| Create Folders | Yes | Yes | Yes |
| Rename / Move / Delete own files | Yes | Yes | Yes |
| Share files | Yes | Yes | Yes |
| Access Admin Panel | Yes | No | No |
| Manage Users | Yes | No | No |
| Manage Storage Locations | Yes | No | No |
| View Activity Logs | Yes | No | No |
| IP Whitelist/Blacklist | Yes | No | No |
| See all users' files | Yes | No | No |

- **SuperAdmin** sees the global `uploads/` directory and all users' home directories.
- **Admin** and **User** roles see only their own home directory (`uploads/users/{username}/`).
- Files can be shared across users via share links.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search |
| `V` | Toggle grid/list view |
| `Delete` | Delete selected file(s) |
| `Enter` | Preview selected file |
| `Ctrl+A` | Select all files |
| `Ctrl+V` | Paste from clipboard |
| `Escape` | Clear selection / Close modals |

---

## API Reference

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/login` | Login, returns JWT token |
| `POST` | `/api/auth/register` | Register new user |
| `GET` | `/api/auth/me` | Get current user info |
| `GET` | `/api/auth/status` | Auth system status (health check) |

### Files

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/contents?path=` | List files/folders in path |
| `POST` | `/api/upload?parentPath=` | Upload file |
| `GET` | `/api/download?file=&parentPath=` | Download file |
| `GET` | `/api/preview?file=&parentPath=` | Preview file inline |
| `PUT` | `/api/files/:filename(*)` | Rename file |
| `DELETE` | `/api/files/:filename(*)` | Delete file (move to trash) |
| `POST` | `/api/folder` | Create folder |
| `POST` | `/api/move` | Move file/folder |
| `POST` | `/api/paste-upload` | Upload from clipboard |
| `POST` | `/api/batch/download` | Download multiple as ZIP |
| `POST` | `/api/batch/delete` | Batch delete |
| `POST` | `/api/batch/move` | Batch move |

### Sharing

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/share` | Create share link |
| `GET` | `/api/shares` | List active shares |
| `DELETE` | `/api/shares/:id` | Revoke share |
| `GET` | `/api/share-download/:id` | Download shared file |

### File Metadata

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/checksum?file=&algorithm=` | Compute/verify file checksum |
| `GET/POST` | `/api/tags/:filename(*)` | Get/set file tags |
| `GET/POST` | `/api/comments/:filename(*)` | Get/add file comments |
| `POST/GET` | `/api/favorites` | Toggle/list favorites |
| `GET` | `/api/versions/:filename(*)` | Get file version history |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/admin/users` | List all users |
| `POST` | `/api/admin/users` | Create user |
| `PUT` | `/api/admin/users/:username` | Update user |
| `DELETE` | `/api/admin/users/:username` | Delete user |
| `GET` | `/api/admin/storage-locations` | List storage locations |
| `POST` | `/api/admin/storage-locations` | Add storage location |
| `PUT` | `/api/admin/storage-locations/:id` | Update storage location |
| `DELETE` | `/api/admin/storage-locations/:id` | Remove storage location |
| `GET` | `/api/admin/stats` | System statistics |
| `GET` | `/api/admin/activity` | Activity log |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/search?q=` | Search files |
| `GET` | `/api/storage` | Storage usage info |
| `GET` | `/api/notifications` | Get notifications |
| `GET` | `/api/qr?url=` | Generate QR code |

---

## Project Structure

```
BlackDrop/
├── server.js              # Express backend (API, Socket.io, auth, file ops)
├── package.json
├── Dockerfile
├── docker-compose.yml
├── certs/                 # SSL certificates (auto-generated)
│   ├── key.pem
│   └── cert.pem
├── public/                # Frontend
│   ├── index.html         # Main application page
│   ├── script.js          # Client-side JavaScript
│   ├── style.css          # Styles (glassmorphism theme)
│   ├── admin.html         # Admin panel
│   ├── share.html         # Public share download page
│   └── lang/              # i18n language files
│       ├── tr.json
│       └── en.json
├── uploads/               # File storage root
│   └── users/             # Per-user home directories
│       └── {username}/
├── .trash/                # Recycle bin
├── .data/                 # Persistent JSON data stores
│   ├── users.json
│   ├── shares.json
│   ├── tags.json
│   ├── comments.json
│   ├── checksums.json
│   ├── downloads.json
│   ├── file-versions.json
│   ├── file-access.json
│   ├── favorites.json
│   ├── activity.json
│   ├── notifications.json
│   ├── settings.json
│   ├── storage-locations.json
│   ├── ip-config.json
│   ├── search-history.json
│   └── recent.json
└── tests/
    └── api.test.js        # API integration tests
```

---

## Data Persistence

All application data is stored as JSON files in the `.data/` directory. Data is:
- Loaded into memory on startup
- Saved to disk immediately on write operations
- Auto-saved every 60 seconds as a safety net

When using Docker, mount the `.data` volume to persist data across container restarts.

---

## License

MIT License - free to use for personal or commercial purposes.

---

<p align="center">
  Made with care by <a href="https://github.com/Exquve">Exquve</a>
</p>
