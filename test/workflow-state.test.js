const test = require('node:test');
const assert = require('node:assert/strict');
const {
    WORKFLOW_STATUS,
    confirmSelection,
    confirmCheck,
    reopenSelection
} = require('../server/workflow-state');

test('selection confirmation only locks the selection and does not enter FINAL', () => {
    const next = confirmSelection({ workflowStatus: WORKFLOW_STATUS.SELECTION_OPEN, expiresAt: null }, '2026-07-21T01:00:00.000Z');
    assert.equal(next.workflowStatus, WORKFLOW_STATUS.SELECTION_CONFIRMED);
    assert.equal(next.selectionConfirmedAt, '2026-07-21T01:00:00.000Z');
    assert.equal(next.expiresAt, null);
    assert.equal(next.finalizedAt, null);
});

test('CHECK confirmation is the only transition to FINAL', () => {
    const next = confirmCheck({ workflowStatus: WORKFLOW_STATUS.CHECK_PENDING, checkVersion: 2 }, '2026-07-21T01:00:00.000Z', 60);
    assert.equal(next.workflowStatus, WORKFLOW_STATUS.COMPLETED);
    assert.equal(next.finalizedAt, '2026-07-21T01:00:00.000Z');
    assert.equal(next.checkAcceptedAt, '2026-07-21T01:00:00.000Z');
    assert.equal(next.expiresAt, '2026-09-19T01:00:00.000Z');
});

test('reopening a selection leaves prior CHECK data but clears FINAL state', () => {
    const next = reopenSelection({
        workflowStatus: WORKFLOW_STATUS.COMPLETED,
        checkReady: true,
        checkFolderId: 'check-folder',
        expiresAt: '2026-09-19T01:00:00.000Z',
        finalizedAt: '2026-07-21T01:00:00.000Z'
    }, '2026-07-21T02:00:00.000Z');
    assert.equal(next.workflowStatus, WORKFLOW_STATUS.SELECTION_OPEN);
    assert.equal(next.checkReady, true);
    assert.equal(next.checkFolderId, 'check-folder');
    assert.equal(next.expiresAt, null);
    assert.equal(next.finalizedAt, null);
});
