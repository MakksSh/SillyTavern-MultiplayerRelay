const { v4: uuidv4 } = require('uuid');
const { createRoomRecord, createPlayerRecord, rooms } = require('./state');
const { createGuestUrl, createExtensionWsUrl } = require('./protocol');

function normalizeRequestedRoomId(requestedRoomId) {
  const trimmed = String(requestedRoomId || '').trim();

  if (!trimmed) {
    return uuidv4();
  }

  if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
    throw new Error('Room ID may only contain latin letters and numbers');
  }

  if (rooms.has(trimmed)) {
    throw new Error('Room ID is already in use');
  }

  return trimmed;
}

function createRoomSession(publicBaseUrl, roomName, requestedRoomId) {
  const room = createRoomRecord({
    id: normalizeRequestedRoomId(requestedRoomId),
    name: roomName,
  });
  rooms.set(room.id, room);

  return {
    room,
    roomId: room.id,
    roomName: room.name,
    hostPairKey: room.hostPairKey,
    guestUrl: createGuestUrl(publicBaseUrl, room.id),
    extensionWsUrl: createExtensionWsUrl(publicBaseUrl, room.id, room.hostPairKey),
  };
}

function getRoomOrThrow(roomId) {
  const room = rooms.get(roomId);

  if (!room) {
    throw new Error('Room not found');
  }

  return room;
}

function refreshRoomStatus(room) {
  if (room.currentTurn.activeTurnId) {
    room.status = 'generating';
    return;
  }

  room.status = room.hostSocketId ? 'ready' : 'waiting_host';
}

function joinRoom(roomId, { socketId, name, role }) {
  const room = getRoomOrThrow(roomId);
  const player = createPlayerRecord({
    socketId,
    name: String(name || '').trim(),
    role,
  });

  if (!player.name) {
    throw new Error('Name is required');
  }

  room.players.set(player.id, player);

  if (role === 'admin') {
    room.adminSocketId = socketId;
  }

  refreshRoomStatus(room);
  return { room, player };
}

function setHostConnection(roomId, socketId) {
  const room = getRoomOrThrow(roomId);
  room.hostSocketId = socketId;
  refreshRoomStatus(room);
  return room;
}

function clearSocketConnection(roomId, socketId) {
  const room = rooms.get(roomId);

  if (!room) {
    return null;
  }

  if (room.hostSocketId === socketId) {
    room.hostSocketId = null;
  }

  if (room.adminSocketId === socketId) {
    room.adminSocketId = null;
  }

  for (const [playerId, player] of room.players.entries()) {
    if (player.socketId === socketId) {
      room.players.delete(playerId);
    }
  }

  refreshRoomStatus(room);
  return room;
}

function getPlayerOrThrow(room, playerId) {
  const player = room.players.get(playerId);

  if (!player) {
    throw new Error('Player not found');
  }

  return player;
}

function updatePlayerDraft(roomId, playerId, text) {
  const room = getRoomOrThrow(roomId);
  const player = getPlayerOrThrow(room, playerId);
  const nextDraft = String(text || '');

  if (player.ready && player.draft !== nextDraft) {
    throw new Error('Unready first to edit the draft');
  }

  player.draft = nextDraft;
  return room;
}

function updatePlayerReady(roomId, playerId, ready) {
  const room = getRoomOrThrow(roomId);
  const player = getPlayerOrThrow(room, playerId);
  player.ready = Boolean(ready);
  return room;
}

function updateAdminNote(roomId, playerId, text) {
  const room = getRoomOrThrow(roomId);
  const player = getPlayerOrThrow(room, playerId);

  if (player.role !== 'admin') {
    throw new Error('Only admin can update admin note');
  }

  if (player.ready && room.currentTurn.adminNote !== String(text || '')) {
    throw new Error('Unready first to edit the admin note');
  }

  room.currentTurn.adminNote = String(text || '');
  return room;
}

function updateRenderOptions(roomId, playerId, options = {}) {
  const room = getRoomOrThrow(roomId);
  const player = getPlayerOrThrow(room, playerId);

  if (player.role !== 'admin') {
    throw new Error('Only admin can update render options');
  }

  const allowHtml = Boolean(options.allowHtml);
  room.renderOptions = {
    allowHtml,
    allowStyles: allowHtml && Boolean(options.allowStyles),
  };

  return room;
}

function renamePlayer(roomId, playerId, name) {
  const room = getRoomOrThrow(roomId);
  const player = getPlayerOrThrow(room, playerId);
  const trimmedName = String(name || '').trim();

  if (!trimmedName) {
    throw new Error('Name is required');
  }

  player.name = trimmedName;
  return room;
}

function appendOocMessage(roomId, playerId, text) {
  const room = getRoomOrThrow(roomId);
  const player = getPlayerOrThrow(room, playerId);
  const trimmedText = String(text || '').trim();

  if (!trimmedText) {
    throw new Error('OOC message is empty');
  }

  room.oocLog.push({
    id: uuidv4(),
    author: player.name,
    text: trimmedText,
    createdAt: Date.now(),
  });

  return room;
}

function appendSystemMessage(room, text) {
  room.gameLog.push({
    id: uuidv4(),
    type: 'system',
    text: String(text),
    createdAt: Date.now(),
  });
}

function getConnectedPlayers(room) {
  return Array.from(room.players.values()).filter((player) => player.connected);
}

function buildTurnMessage(room) {
  const readyPlayers = getConnectedPlayers(room).filter((player) => player.ready);
  const readyPlayersWithDraft = readyPlayers.filter((player) => player.draft.trim());

  if (readyPlayers.some((player) => !player.draft.trim())) {
    throw new Error('Ready player has an empty draft');
  }

  if (!readyPlayersWithDraft.length) {
    throw new Error('No ready players with drafts');
  }

  const blocks = readyPlayersWithDraft.map((player) => `[${player.name}]\n${player.draft.trim()}`);
  const adminNote = room.currentTurn.adminNote.trim();

  if (adminNote) {
    blocks.push(`(OOC:{adminNote})`);
  }

  return {
    readyPlayers,
    message: blocks.join('\n\n'),
  };
}

function startTurn(roomId, { force }) {
  const room = getRoomOrThrow(roomId);

  if (room.status === 'generating') {
    throw new Error('Tavern is already generating');
  }

  if (!room.hostSocketId) {
    throw new Error('Tavern extension is not connected');
  }

  const connectedPlayers = getConnectedPlayers(room);

  if (!connectedPlayers.length) {
    throw new Error('No connected players in room');
  }

  if (!force && connectedPlayers.some((player) => !player.ready)) {
    throw new Error('Not all connected players are ready');
  }

  const { message } = buildTurnMessage(room);
  const turnId = uuidv4();

  room.currentTurn.activeTurnId = turnId;
  room.currentTurn.kind = 'submit';
  room.currentTurn.submittedMessage = message;
  refreshRoomStatus(room);

  return {
    room,
    turnId,
    message,
  };
}

function startRegeneration(roomId) {
  const room = getRoomOrThrow(roomId);

  if (room.status === 'generating') {
    throw new Error('Tavern is already generating');
  }

  if (!room.hostSocketId) {
    throw new Error('Tavern extension is not connected');
  }

  if (!room.gameLog.some((entry) => entry.type === 'ai_reply')) {
    throw new Error('No AI reply available to regenerate');
  }

  const turnId = uuidv4();
  room.currentTurn.activeTurnId = turnId;
  room.currentTurn.kind = 'regenerate';
  room.currentTurn.submittedMessage = '';
  refreshRoomStatus(room);

  return {
    room,
    turnId,
  };
}

function markGenerationStarted(roomId, turnId) {
  const room = getRoomOrThrow(roomId);

  if (room.currentTurn.activeTurnId !== turnId) {
    throw new Error('Turn ID mismatch');
  }

  room.status = 'generating';
  return room;
}

function finishGeneration(roomId, turnId, reply) {
  const room = getRoomOrThrow(roomId);

  if (room.currentTurn.activeTurnId !== turnId) {
    throw new Error('Turn ID mismatch');
  }

  if (room.currentTurn.kind === 'submit') {
    const submittedMessage = room.currentTurn.submittedMessage;

    room.gameLog.push({
      id: uuidv4(),
      type: 'player_turn',
      author: 'Players',
      text: submittedMessage,
      createdAt: Date.now(),
    });

    room.gameLog.push({
      id: uuidv4(),
      type: 'ai_reply',
      author: 'Tavern',
      text: String(reply || ''),
      createdAt: Date.now(),
    });

    for (const player of room.players.values()) {
      if (player.ready) {
        player.draft = '';
      }

      player.ready = false;
    }
    room.currentTurn.adminNote = '';
  }

  room.currentTurn.activeTurnId = null;
  room.currentTurn.kind = null;
  room.currentTurn.submittedMessage = '';
  refreshRoomStatus(room);

  return room;
}

function failGeneration(roomId, turnId, errorText) {
  const room = getRoomOrThrow(roomId);

  if (room.currentTurn.activeTurnId !== turnId) {
    throw new Error('Turn ID mismatch');
  }

  appendSystemMessage(room, `Generation failed: ${String(errorText || 'Unknown error')}`);
  room.currentTurn.activeTurnId = null;
  room.currentTurn.kind = null;
  room.currentTurn.submittedMessage = '';
  refreshRoomStatus(room);

  return room;
}

function replaceGameLog(roomId, entries) {
  const room = getRoomOrThrow(roomId);
  const normalizedEntries = Array.isArray(entries) ? entries : [];

  room.gameLog = normalizedEntries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: uuidv4(),
      type: entry.type === 'system' ? 'system' : entry.type === 'player_turn' ? 'player_turn' : 'ai_reply',
      author: entry.author ? String(entry.author) : undefined,
      text: String(entry.text || ''),
      createdAt: Number(entry.createdAt) || Date.now(),
    }));

  return room;
}

function serializeRoomState(roomId, viewer = {}) {
  const room = getRoomOrThrow(roomId);
  const { role, playerId } = viewer;

  return {
    roomId: room.id,
    roomName: room.name,
    status: room.status,
    turnKind: room.currentTurn.kind,
    hostConnected: Boolean(room.hostSocketId),
    renderOptions: room.renderOptions,
    selfPlayerId: playerId || null,
    players: Array.from(room.players.values()).map((player) => {
      return {
        id: player.id,
        name: player.name,
        role: player.role,
        ready: player.ready,
        connected: player.connected,
        hasDraft: Boolean(player.draft.trim()),
        draft: player.draft,
      };
    }),
    gameLog: room.gameLog,
    oocLog: room.oocLog,
    adminNote: role === 'admin' ? room.currentTurn.adminNote : '',
  };
}

module.exports = {
  rooms,
  appendOocMessage,
  appendSystemMessage,
  clearSocketConnection,
  createRoomSession,
  failGeneration,
  finishGeneration,
  getRoomOrThrow,
  joinRoom,
  markGenerationStarted,
  startRegeneration,
  renamePlayer,
  replaceGameLog,
  serializeRoomState,
  setHostConnection,
  startTurn,
  updateAdminNote,
  updateRenderOptions,
  updatePlayerDraft,
  updatePlayerReady,
};
