import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addGroupMember,
  appendMessage,
  emptyChatState,
  ensureDmThread,
  ensureGroupThread,
  messagePreview,
  migrateDmPeer,
  clearStaleTranscriptPending,
  patchMessage,
  queuedPackets,
  remapPeerInGroups,
} from './chatStore.ts';

const previousId = 'aa:bb:cc:dd:ee:ff';
const peerId = '11111111-2222-4333-8444-555555555555';

function message(overrides = {}) {
  return {
    id: 'message-1',
    threadId: previousId,
    senderId: 'local-device',
    sender: 'You',
    mine: true,
    kind: 'text',
    body: 'hello',
    status: 'queued',
    time: '9:00 AM',
    timestamp: 100,
    ...overrides,
  };
}

describe('chatStore identity migration', () => {
  it('moves a provisional thread and queued packet to the canonical peer ID', () => {
    const initial = appendMessage(
      ensureDmThread(emptyChatState, previousId, 'Nearby peer'),
      message(),
      'Nearby peer',
      false,
    );

    const migrated = migrateDmPeer(initial, previousId, peerId, 'Taylor');

    assert.equal(migrated.messages[previousId], undefined);
    assert.equal(migrated.messages[peerId].length, 1);
    assert.equal(migrated.messages[peerId][0].id, 'message-1');
    assert.equal(migrated.messages[peerId][0].threadId, peerId);
    assert.deepEqual(
      {
        id: migrated.threads[0].id,
        peerId: migrated.threads[0].peerId,
        name: migrated.threads[0].name,
        queued: migrated.threads[0].queued,
      },
      { id: peerId, peerId, name: 'Taylor', queued: true },
    );
    const packets = queuedPackets(migrated, peerId, 'local-device');
    assert.equal(packets.length, 1);
    assert.equal(packets[0].id, 'message-1');
    assert.equal(packets[0].recipientId, peerId);
  });

  it('deduplicates messages when provisional and canonical threads are merged', () => {
    const provisional = appendMessage(emptyChatState, message(), 'Nearby peer', false);
    const split = appendMessage(
      provisional,
      message({ threadId: peerId }),
      'Taylor',
      false,
    );

    const migrated = migrateDmPeer(split, previousId, peerId, 'Taylor');

    assert.equal(migrated.messages[peerId].length, 1);
    assert.equal(migrated.threads.length, 1);
  });
});

describe('chatStore delivery and unread state', () => {
  it('preserves unread messages when an outgoing message is appended', () => {
    const incoming = appendMessage(
      emptyChatState,
      message({
        id: 'incoming',
        threadId: peerId,
        senderId: peerId,
        mine: false,
        status: undefined,
      }),
      'Taylor',
      true,
    );

    const withReply = appendMessage(
      incoming,
      message({ id: 'reply', threadId: peerId }),
      'Taylor',
      false,
    );

    assert.equal(withReply.threads[0].unread, 1);
  });

  it('promotes a queued message only after the send completes', () => {
    const queued = appendMessage(
      emptyChatState,
      message({ threadId: peerId }),
      'Taylor',
      false,
    );
    const sent = patchMessage(queued, peerId, 'message-1', { status: 'sent' });

    assert.equal(queued.messages[peerId][0].status, 'queued');
    assert.equal(sent.messages[peerId][0].status, 'sent');
    assert.equal(sent.threads[0].queued, false);
  });

  it('uses readable previews for image and voice messages', () => {
    const image = message({ id: 'photo', kind: 'image', body: '' });
    const audio = message({ id: 'voice', kind: 'audio', body: '' });
    const state = appendMessage(emptyChatState, image, 'Taylor', true);

    assert.equal(messagePreview(image), 'Photo');
    assert.equal(messagePreview(audio), 'Voice message');
    assert.equal(state.threads[0].preview, 'Photo');
    assert.equal(state.threads[0].unread, 1);
    assert.deepEqual(queuedPackets(state, previousId, 'local-device'), []);
  });

  it('clears orphaned pending transcript status on relaunch', () => {
    const audio = message({
      id: 'voice',
      kind: 'audio',
      body: 'Voice message',
      transcriptStatus: 'pending',
    });
    const state = {
      threads: [],
      messages: { peer: [audio] },
    };
    const cleared = clearStaleTranscriptPending(state);
    assert.equal(cleared.messages.peer[0].transcriptStatus, undefined);
  });

  it('clears orphaned pending translation status on relaunch', () => {
    const audio = message({
      id: 'voice',
      kind: 'audio',
      body: 'Voice message',
      transcript: 'Bonjour',
      transcriptStatus: 'ready',
      translationStatus: 'pending',
    });
    const state = {
      threads: [],
      messages: { peer: [audio] },
    };
    const cleared = clearStaleTranscriptPending(state);
    assert.equal(cleared.messages.peer[0].translationStatus, undefined);
    assert.equal(cleared.messages.peer[0].transcriptStatus, 'ready');
  });
});

describe('chatStore groups', () => {
  it('creates a group thread and keeps later messages on that thread', () => {
    const created = ensureGroupThread(emptyChatState, {
      id: 'group-1',
      name: 'Hallway Ops',
      members: [
        { id: 'local-device', name: 'You' },
        { id: peerId, name: 'Taylor' },
      ],
    });
    const next = appendMessage(
      created,
      message({
        id: 'g1',
        threadId: 'group-1',
        senderId: peerId,
        mine: false,
        status: undefined,
      }),
      'Hallway Ops',
      true,
    );

    assert.equal(created.threads[0].kind, 'group');
    assert.equal(created.threads[0].memberIds.length, 2);
    assert.equal(next.threads[0].kind, 'group');
    assert.equal(next.threads[0].name, 'Hallway Ops');
    assert.equal(next.threads[0].unread, 1);
    assert.equal(next.messages['group-1'][0].threadId, 'group-1');
  });

  it('caps membership at eight and remaps a member id', () => {
    const members = Array.from({ length: 8 }, (_, index) => ({
      id: `member-${index}`,
      name: `P${index}`,
    }));
    const full = ensureGroupThread(emptyChatState, {
      id: 'group-1',
      name: 'Ops',
      members,
    });
    const ignored = addGroupMember(full, 'group-1', { id: 'member-extra', name: 'Extra' });
    const remapped = remapPeerInGroups(full, 'member-1', peerId, 'Taylor');

    assert.equal(full.threads[0].memberIds.length, 8);
    assert.equal(ignored.threads[0].memberIds.length, 8);
    assert.equal(ignored.threads[0].memberIds.includes('member-extra'), false);
    assert.equal(remapped.threads[0].memberIds.includes('member-1'), false);
    assert.equal(remapped.threads[0].memberIds.includes(peerId), true);
    assert.equal(remapped.threads[0].memberNames[peerId], 'Taylor');
  });
});
