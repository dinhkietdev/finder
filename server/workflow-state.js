const WORKFLOW_STATUS = Object.freeze({
    SELECTION_OPEN: 'selection_open',
    SELECTION_CONFIRMED: 'selection_confirmed',
    CHECK_PENDING: 'check_pending',
    REVISION_REQUESTED: 'revision_requested',
    COMPLETED: 'completed'
});

function isoNow(value) {
    return value || new Date().toISOString();
}

function confirmSelection(settings = {}, at) {
    const selectionConfirmedAt = isoNow(at);
    return {
        ...settings,
        workflowStatus: WORKFLOW_STATUS.SELECTION_CONFIRMED,
        selectionConfirmedAt,
        checkAcceptedAt: null,
        expiresAt: null,
        finalizedAt: null
    };
}

function confirmCheck(settings = {}, at, expiresDays = 60) {
    const checkAcceptedAt = isoNow(at);
    const days = Math.max(1, Number(expiresDays) || 60);
    return {
        ...settings,
        workflowStatus: WORKFLOW_STATUS.COMPLETED,
        checkNeedsRevision: false,
        checkAcceptedAt,
        finalizedAt: checkAcceptedAt,
        expiresAt: new Date(Date.parse(checkAcceptedAt) + days * 86400000).toISOString()
    };
}

function reopenSelection(settings = {}, at) {
    return {
        ...settings,
        workflowStatus: WORKFLOW_STATUS.SELECTION_OPEN,
        selectionReopenedAt: isoNow(at),
        checkNeedsRevision: false,
        checkAcceptedAt: null,
        expiresAt: null,
        finalizedAt: null
    };
}

module.exports = { WORKFLOW_STATUS, confirmSelection, confirmCheck, reopenSelection };
