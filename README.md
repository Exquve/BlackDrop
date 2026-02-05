# BlackDrop 🌩️

A modern, beautiful file sharing application with real-time updates. Share files securely across your local network with a stunning glassmorphism UI.

![BlackDrop](https://img.shields.io/badge/BlackDrop-v1.0.0-8b5cf6?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

## ✨ Features

- 🎨 **Modern UI** - Glassmorphism design with smooth animations
- 📤 **Drag & Drop Upload** - Simply drag files to upload
- 🔄 **Real-time Updates** - Instant file sync via Socket.io
- 🔍 **Smart Search** - Filter files by name, type, or category
- 📁 **File Preview** - Preview images and videos directly in browser
- 🎯 **Multi-select** - Select multiple files with Ctrl+Click
- ⌨️ **Keyboard Shortcuts** - Navigate efficiently with shortcuts
- 🌙 **Theme Toggle** - Dark/Light mode support
- 📊 **Storage Indicator** - Track your storage usage
- 📝 **File Operations** - Rename, delete, download with context menu
- 🔒 **HTTPS** - Secure connection with SSL

## 🚀 Quick Start

### Prerequisites

- Node.js 18 or higher
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/Exquve/BlackDrop.git
cd BlackDrop

# Install dependencies
npm install

# Generate SSL certificates (required for HTTPS)
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj "/CN=localhost"

# Start the server
npm start
```

### Access

- **Local:** https://localhost:3000
- **Network:** https://YOUR_IP:3000

> ⚠️ You'll see a security warning in your browser. This is normal for self-signed certificates. Click "Advanced" → "Proceed to localhost".

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search |
| `V` | Toggle grid/list view |
| `Delete` | Delete selected file |
| `Enter` | Preview selected file |
| `Ctrl+A` | Select all files |
| `Escape` | Clear selection / Close modals |

## 📁 Project Structure

```
BlackDrop/
├── server.js          # Express server with Socket.io
├── package.json       # Dependencies
├── certs/             # SSL certificates
│   ├── key.pem
│   └── cert.pem
├── public/            # Frontend files
│   ├── index.html     # Main HTML
│   ├── style.css      # Styles with animations
│   └── script.js      # Client-side JavaScript
└── uploads/           # Uploaded files directory
```

## 🛠️ API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/files` | List all files |
| `POST` | `/upload` | Upload a file |
| `GET` | `/download/:filename` | Download a file |
| `PUT` | `/files/:filename` | Rename a file |
| `DELETE` | `/files/:filename` | Delete a file |
| `GET` | `/storage` | Get storage info |

## 🎨 Customization

### Change Storage Quota

Edit `server.js` and modify the `totalQuota` value:

```javascript
const totalQuota = 10 * 1024 * 1024 * 1024; // 10GB default
```

### Change Port

Edit `server.js`:

```javascript
const PORT = 3000; // Change to your preferred port
```

## 📜 License

MIT License - feel free to use this project for personal or commercial purposes.

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/Exquve">Exquve</a>
</p>
