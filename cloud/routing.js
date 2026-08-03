function normalizePriorityIds(value) {
    return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
}

function byPriority(items, priorityAccountIds) {
    const order = new Map(priorityAccountIds.map((id, index) => [id, index]));
    return [...items].sort((a, b) => {
        const aOrder = order.get(a.account.id);
        const bOrder = order.get(b.account.id);
        if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
        if (aOrder !== undefined) return -1;
        if (bOrder !== undefined) return 1;
        return new Date(a.account.createdAt).getTime() - new Date(b.account.createdAt).getTime();
    });
}

/**
 * Select a connected cloud account for upload based on routing policy.
 * accounts: [{ id, provider, createdAt, availableBytes }]
 * routing: { mode, priorityAccountIds, roundRobinCursor }
 */
function selectAccount(accounts, sizeBytes, routing, { targetAccountId, reservedBytesByAccount = new Map() } = {}) {
    let list = accounts.filter(a => a.status === 'connected' || a.status === undefined);

    if (targetAccountId) {
        list = list.filter(a => a.id === targetAccountId);
    }

    const eligible = list
        .map(account => {
            const reserved = reservedBytesByAccount.get(account.id) || 0;
            const available = account.availableBytes == null ? null : account.availableBytes - reserved;
            return { account, availableBytes: available };
        })
        .filter(({ availableBytes }) => availableBytes === null || availableBytes >= sizeBytes);

    if (eligible.length === 0) return { account: null, routing };

    if (targetAccountId) {
        return { account: eligible[0]?.account || null, routing };
    }

    const mode = ['most_available', 'round_robin', 'priority'].includes(routing.mode)
        ? routing.mode
        : 'most_available';
    const priorityAccountIds = normalizePriorityIds(routing.priorityAccountIds);
    const nextRouting = { ...routing };

    if (mode === 'priority') {
        return { account: byPriority(eligible, priorityAccountIds)[0]?.account || null, routing: nextRouting };
    }

    if (mode === 'round_robin') {
        const ordered = byPriority(eligible, priorityAccountIds);
        const cursor = nextRouting.roundRobinCursor || 0;
        const selected = ordered[cursor % ordered.length]?.account || ordered[0]?.account || null;
        nextRouting.roundRobinCursor = cursor + 1;
        return { account: selected, routing: nextRouting };
    }

    // most_available
    const sorted = eligible.sort((a, b) => {
        if (a.availableBytes === null && b.availableBytes === null) {
            return a.account.provider === 's3' ? -1 : 1;
        }
        if (a.availableBytes === null) return a.account.provider === 's3' ? -1 : 1;
        if (b.availableBytes === null) return b.account.provider === 's3' ? 1 : -1;
        return b.availableBytes - a.availableBytes;
    });

    return { account: sorted[0]?.account || null, routing: nextRouting };
}

module.exports = { selectAccount, normalizePriorityIds };
