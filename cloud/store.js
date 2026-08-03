const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uuid = () => crypto.randomUUID();

function createCloudStore(dataDir) {
    const cloudDir = path.join(dataDir, 'cloud');
    if (!fs.existsSync(cloudDir)) fs.mkdirSync(cloudDir, { recursive: true });

    const files = {
        googleConfig: path.join(cloudDir, 'google-config.json'),
        accounts: path.join(cloudDir, 'accounts.json'),
        s3Configs: path.join(cloudDir, 's3-configs.json'),
        quotas: path.join(cloudDir, 'quotas.json'),
        folders: path.join(cloudDir, 'folders.json'),
        files: path.join(cloudDir, 'files.json'),
        routing: path.join(cloudDir, 'routing.json'),
        apiKeys: path.join(cloudDir, 'api-keys.json'),
        oauthStates: path.join(cloudDir, 'oauth-states.json'),
    };

    function load(file, def) {
        try {
            if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            console.error('[cloud] load error', file, e.message);
        }
        return typeof def === 'function' ? def() : structuredClone(def);
    }

    function save(file, data) {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }

    const state = {
        googleConfig: load(files.googleConfig, null),
        accounts: load(files.accounts, []),
        s3Configs: load(files.s3Configs, {}),
        quotas: load(files.quotas, {}),
        folders: load(files.folders, []),
        cloudFiles: load(files.files, []),
        routing: load(files.routing, { mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 }),
        apiKeys: load(files.apiKeys, []),
        oauthStates: load(files.oauthStates, {}),
    };

    const persist = {
        googleConfig: () => save(files.googleConfig, state.googleConfig),
        accounts: () => save(files.accounts, state.accounts),
        s3Configs: () => save(files.s3Configs, state.s3Configs),
        quotas: () => save(files.quotas, state.quotas),
        folders: () => save(files.folders, state.folders),
        cloudFiles: () => save(files.files, state.cloudFiles),
        routing: () => save(files.routing, state.routing),
        apiKeys: () => save(files.apiKeys, state.apiKeys),
        oauthStates: () => save(files.oauthStates, state.oauthStates),
    };

    return { uuid, state, persist, cloudDir };
}

module.exports = { createCloudStore };
