const request = require('supertest');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Allow self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Start the server before tests
let server;
let baseUrl;

beforeAll((done) => {
    // Dynamically require server and get the running instance
    // We need to capture the server port
    const originalLog = console.log;
    console.log = (...args) => {
        const msg = args.join(' ');
        if (msg.includes('HTTPS Server running')) {
            const match = msg.match(/port (\d+)/);
            if (match) baseUrl = `https://localhost:${match[1]}`;
        }
        originalLog(...args);
    };

    server = require('../server.js');

    // Wait for server to start
    setTimeout(() => {
        console.log = originalLog;
        if (!baseUrl) baseUrl = 'https://localhost:3000';
        done();
    }, 2000);
});

afterAll((done) => {
    if (server && server.close) {
        server.close(done);
    } else {
        done();
    }
});

// Create an agent that ignores SSL errors
const agent = new https.Agent({ rejectUnauthorized: false });

describe('Auth API', () => {
    test('GET /api/auth/status should return auth status', async () => {
        const res = await request(baseUrl)
            .get('/api/auth/status')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('authEnabled');
    });

    test('POST /api/auth/login with valid credentials should succeed', async () => {
        const res = await request(baseUrl)
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'admin' })
            .trustLocalhost();
        // Auth may be disabled, so either 200 with token or other status
        if (res.body.authEnabled === false) {
            expect(res.status).toBe(200);
        } else {
            expect(res.status).toBe(200);
            if (res.body.token) {
                expect(res.body).toHaveProperty('token');
                expect(res.body).toHaveProperty('username', 'admin');
            }
        }
    });

    test('POST /api/auth/login with invalid credentials should fail', async () => {
        const res = await request(baseUrl)
            .post('/api/auth/login')
            .send({ username: 'admin', password: 'wrongpassword' })
            .trustLocalhost();
        expect([400, 401]).toContain(res.status);
    });
});

describe('File API', () => {
    test('GET /api/contents should return directory listing', async () => {
        const res = await request(baseUrl)
            .get('/api/contents')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    test('GET /api/storage should return storage info', async () => {
        const res = await request(baseUrl)
            .get('/api/storage')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('used');
        expect(res.body).toHaveProperty('total');
    });

    test('POST /api/folders should create a folder', async () => {
        const folderName = `test-folder-${Date.now()}`;
        const res = await request(baseUrl)
            .post('/api/folders')
            .send({ name: folderName })
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('message');

        // Cleanup
        await request(baseUrl)
            .delete(`/api/folders/${folderName}`)
            .trustLocalhost();
    });
});

describe('Favorites API', () => {
    test('GET /api/favorites should return favorites list', async () => {
        const res = await request(baseUrl)
            .get('/api/favorites')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

describe('Recent API', () => {
    test('GET /api/recent should return recent files', async () => {
        const res = await request(baseUrl)
            .get('/api/recent')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

describe('Tags API', () => {
    test('GET /api/tags should return tags', async () => {
        const res = await request(baseUrl)
            .get('/api/tags')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(typeof res.body).toBe('object');
    });
});

describe('Trash API', () => {
    test('GET /api/trash should return trash items', async () => {
        const res = await request(baseUrl)
            .get('/api/trash')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

describe('Search API', () => {
    test('GET /api/search should perform search', async () => {
        const res = await request(baseUrl)
            .get('/api/search?query=test')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

describe('Activity API', () => {
    test('GET /api/activity should return activity log', async () => {
        const res = await request(baseUrl)
            .get('/api/activity')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

describe('Shares API', () => {
    test('GET /api/shares should return shares list', async () => {
        const res = await request(baseUrl)
            .get('/api/shares')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

describe('New Features API', () => {
    test('GET /api/notifications should return notifications', async () => {
        const res = await request(baseUrl)
            .get('/api/notifications')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    test('GET /api/search/history should return search history', async () => {
        const res = await request(baseUrl)
            .get('/api/search/history')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    test('POST /api/search/history should save search', async () => {
        const res = await request(baseUrl)
            .post('/api/search/history')
            .send({ query: 'test search' })
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('message');
    });

    test('GET /api/csrf-token should return CSRF token', async () => {
        const res = await request(baseUrl)
            .get('/api/csrf-token')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('csrfToken');
        expect(typeof res.body.csrfToken).toBe('string');
    });

    test('POST /api/batch/tag should handle batch tagging', async () => {
        const res = await request(baseUrl)
            .post('/api/batch/tag')
            .send({ items: ['nonexistent.txt'], tag: 'test-tag', action: 'add' })
            .trustLocalhost();
        expect(res.status).toBe(200);
    });

    test('PUT /api/notifications/read-all should mark all read', async () => {
        const res = await request(baseUrl)
            .put('/api/notifications/read-all')
            .trustLocalhost();
        expect(res.status).toBe(200);
    });
});

describe('Admin API', () => {
    test('GET /api/admin/stats should return admin statistics', async () => {
        const res = await request(baseUrl)
            .get('/api/admin/stats')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('files');
    });

    test('GET /api/admin/stats/charts should return chart data', async () => {
        const res = await request(baseUrl)
            .get('/api/admin/stats/charts?days=7')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('dailyActivity');
        expect(res.body).toHaveProperty('typeDistribution');
        expect(res.body).toHaveProperty('userActivity');
    });

    test('GET /api/admin/backups should return backups list', async () => {
        const res = await request(baseUrl)
            .get('/api/admin/backups')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    test('GET /api/admin/settings should return settings', async () => {
        const res = await request(baseUrl)
            .get('/api/admin/settings')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('authEnabled');
    });

    test('GET /api/admin/users should return users list', async () => {
        const res = await request(baseUrl)
            .get('/api/admin/users')
            .trustLocalhost();
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});
