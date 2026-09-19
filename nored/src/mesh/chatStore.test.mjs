import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendMessage,
  emptyChatState,
  ensureDmThread,
  messagePreview,
  migrateDmPeer,
  patchMessage,
  queuedPackets,
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
});
