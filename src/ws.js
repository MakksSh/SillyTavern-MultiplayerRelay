const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { parseJsonMessage, sendError, sendEvent } = require('./protocol');
const logger = require('./logger');
const {
  appendOocMessage,
  clearSocketConnection,
  createRoomSession,
  failGeneration,
  finishGeneration,
  getRoomOrThrow,
  joinRoom,
  markGenerationStarted,
  renamePlayer,
  replaceGameLog,
  rooms,
  serializeRoomState,
  setHostConnection,
  startRegeneration,
  startTurn,
  updateAdminNote,
  updatePlayerDraft,
  updateRenderOptions,
  updatePlayerReady,
} = require('./rooms');

const DEFAULT_ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function attachWebSocketServer(server, config) {
  const wss = new WebSocket.Server({
    server,
    path: '/ws',
  });
  const adminSessions = new Map();
  const adminSessionTtlMs = Number(config.adminSessionTtlMs) > 0
    ? Number(config.adminSessionTtlMs)
    : DEFAULT_ADMIN_SESSION_TTL_MS;

  function clearExpiredAdminSessions() {
    const now = Date.now();

    for (const [token, session] of adminSessions.entries()) {
      if (!session || session.expiresAt <= now) {
        adminSessions.delete(token);
      }
    }
  }

  function createAdminSessionToken() {
    const now = Date.now();
    const token = uuidv4();
    adminSessions.set(token, {
      createdAt: now,
      expiresAt: now + adminSessionTtlMs,
    });
    return token;
  }

  function touchAdminSessionToken(token) {
    const session = adminSessions.get(token);
    if (!session) {
      return false;
    }

    adminSessions.set(token, {
      ...session,
      expiresAt: Date.now() + adminSessionTtlMs,
    });
    return true;
  }

  function isValidAdminSessionToken(token) {
    clearExpiredAdminSessions();

    if (!token || !adminSessions.has(token)) {
      return false;
    }

    return touchAdminSessionToken(token);
  }

  function getOpenSocketById(socketId) {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && client.__relayMeta?.socketId === socketId) {
        return client;
      }
    }

    return null;
  }

  function getSocketContext(socket) {
    const meta = socket?.__relayMeta || {};

    return {
      socketId: meta.socketId || null,
      roomId: meta.roomId || null,
      playerId: meta.playerId || null,
      role: meta.role || null,
      isAdminAuthenticated: Boolean(meta.isAdminAuthenticated),
    };
  }

  function getRoomContext(roomId) {
    const room = rooms.get(roomId);

    if (!room) {
      return {
        roomId,
        roomExists: false,
      };
    }

    const players = Array.from(room.players.values());
    return {
      roomId: room.id,
      roomExists: true,
      roomName: room.name,
      status: room.status,
      playersCount: players.length,
      readyPlayersCount: players.filter((player) => player.ready).length,
      hostConnected: Boolean(room.hostSocketId),
      adminConnected: Boolean(room.adminSocketId),
      gameLogEntries: room.gameLog.length,
      oocEntries: room.oocLog.length,
      activeTurnId: room.currentTurn.activeTurnId,
      turnKind: room.currentTurn.kind,
    };
  }

  function summarizeEntryTypes(entries) {
    return (Array.isArray(entries) ? entries : []).reduce((accumulator, entry) => {
      const type = entry?.type || 'unknown';
      accumulator[type] = (accumulator[type] || 0) + 1;
      return accumulator;
    }, {});
  }

  function summarizeIncomingPayload(type, payload = {}) {
    switch (type) {
      case 'join_admin':
        return {
          hasSessionToken: Boolean(String(payload.sessionToken || '').trim()),
          hasAdminKey: Boolean(String(payload.adminKey || '').trim()),
          sessionTokenLength: String(payload.sessionToken || '').length,
          adminKeyLength: String(payload.adminKey || '').length,
        };
      case 'create_room':
        return {
          roomId: String(payload.roomId || '').trim(),
          roomName: String(payload.roomName || '').trim(),
          roomIdLength: String(payload.roomId || '').trim().length,
          roomNameLength: String(payload.roomName || '').trim().length,
        };
      case 'update_render_options':
        return {
          allowHtml: Boolean(payload.allowHtml),
          allowStyles: Boolean(payload.allowStyles),
        };
      case 'join_room':
        return {
          roomId: String(payload.roomId || '').trim(),
          name: String(payload.name || '').trim(),
          role: payload.role === 'admin' ? 'admin' : 'guest',
        };
      case 'update_draft':
        return {
          textLength: String(payload.text || '').length,
        };
      case 'set_ready':
        return {
          ready: Boolean(payload.ready),
        };
      case 'send_ooc':
        return {
          textLength: String(payload.text || '').length,
        };
      case 'set_admin_note':
        return {
          textLength: String(payload.text || '').length,
        };
      case 'rename_player':
        return {
          name: String(payload.name || '').trim(),
        };
      case 'send_turn_to_tavern':
        return {
          force: Boolean(payload.force),
        };
      case 'regenerate_in_tavern':
        return {};
      case 'generation_started':
        return {
          turnId: String(payload.turnId || ''),
        };
      case 'generation_finished':
        return {
          turnId: String(payload.turnId || ''),
          replyLength: String(payload.reply || '').length,
        };
      case 'generation_failed':
        return {
          turnId: String(payload.turnId || ''),
          error: String(payload.error || ''),
        };
      case 'sync_chat_history':
        return {
          entriesCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
          entryTypes: summarizeEntryTypes(payload.entries),
        };
      default:
        return payload;
    }
  }

  function emitEvent(socket, type, payload = {}) {
    sendEvent(socket, type, payload);
  }

  function emitError(socket, message, details = {}, context = {}) {
    sendError(socket, message, details);
    logger.warn('ws.message.out.error', {
      ...getSocketContext(socket),
      message,
      details,
      ...context,
    });
  }

  function broadcastRoomState(roomId) {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      const meta = client.__relayMeta;
      if (!meta || meta.role === 'host' || meta.roomId !== roomId || !meta.playerId) {
        continue;
      }

      sendEvent(client, 'room_state', serializeRoomState(roomId, {
        role: meta.role,
        playerId: meta.playerId,
      }));
    }
  }

  function handlePlayerBroadcast(roomId, trigger = 'unknown', context = {}) {
    try {
      broadcastRoomState(roomId);
    } catch (error) {
      logger.error('ws.broadcast.room_state.failed', {
        trigger,
        ...getRoomContext(roomId),
        ...context,
        error,
      });
    }
  }

  function connectHost(socket, requestUrl) {
    const roomId = requestUrl.searchParams.get('roomId');
    const hostPairKey = requestUrl.searchParams.get('hostPairKey');

    if (!roomId || !hostPairKey) {
      emitError(socket, 'Missing host pairing parameters', {}, {
        reason: 'missing_host_pairing_parameters',
      });
      logger.warn('ws.host_pairing.rejected', {
        ...getSocketContext(socket),
        reason: 'missing_host_pairing_parameters',
      });
      socket.close(1008, 'Missing host pairing parameters');
      return;
    }

    let room;
    try {
      room = getRoomOrThrow(roomId);
    } catch (error) {
      emitError(socket, error.message, {}, {
        reason: 'room_not_found',
        roomId,
      });
      logger.warn('ws.host_pairing.rejected', {
        ...getSocketContext(socket),
        reason: 'room_not_found',
        roomId,
      });
      socket.close(1008, error.message);
      return;
    }

    if (room.hostPairKey !== hostPairKey) {
      emitError(socket, 'Invalid host pairing key', {}, {
        reason: 'invalid_host_pair_key',
        roomId,
      });
      logger.warn('ws.host_pairing.rejected', {
        ...getSocketContext(socket),
        reason: 'invalid_host_pair_key',
        roomId,
      });
      socket.close(1008, 'Invalid host pairing key');
      return;
    }

    socket.__relayMeta.role = 'host';
    socket.__relayMeta.roomId = roomId;
    setHostConnection(roomId, socket.__relayMeta.socketId);
    emitEvent(socket, 'host_paired', { roomId });
    logger.info('ws.host_pairing.succeeded', {
      ...getSocketContext(socket),
      ...getRoomContext(roomId),
    });
    handlePlayerBroadcast(roomId, 'host_paired');
  }

  function handleJoinAdmin(socket, payload) {
    const sessionToken = String(payload.sessionToken || '').trim();
    const adminKey = String(payload.adminKey || '').trim();

    if (sessionToken) {
      if (!isValidAdminSessionToken(sessionToken)) {
        emitError(socket, 'Admin session expired. Sign in again.', {
          code: 'invalid_admin_session',
        }, {
          action: 'join_admin',
          authMethod: 'session_token',
        });
        logger.warn('ws.admin_auth.failed', {
          ...getSocketContext(socket),
          authMethod: 'session_token',
          reason: 'invalid_admin_session',
        });
        return;
      }

      socket.__relayMeta.isAdminAuthenticated = true;
      emitEvent(socket, 'admin_joined', {
        ok: true,
        sessionToken,
      });
      logger.info('ws.admin_auth.succeeded', {
        ...getSocketContext(socket),
        authMethod: 'session_token',
      });
      return;
    }

    if (adminKey !== config.adminKey) {
      emitError(socket, 'Invalid admin key', {
        code: 'invalid_admin_key',
      }, {
        action: 'join_admin',
        authMethod: 'admin_key',
      });
      logger.warn('ws.admin_auth.failed', {
        ...getSocketContext(socket),
        authMethod: 'admin_key',
        reason: 'invalid_admin_key',
      });
      return;
    }

    socket.__relayMeta.isAdminAuthenticated = true;
    emitEvent(socket, 'admin_joined', {
      ok: true,
      sessionToken: createAdminSessionToken(),
    });
    logger.info('ws.admin_auth.succeeded', {
      ...getSocketContext(socket),
      authMethod: 'admin_key',
    });
  }

  function handleCreateRoom(socket) {
    if (!socket.__relayMeta.isAdminAuthenticated) {
      emitError(socket, 'Admin authentication required', {}, {
        action: 'create_room',
      });
      return;
    }

    const roomData = createRoomSession(
      config.publicBaseUrl,
      payloadRoomName(socket),
      payloadRequestedRoomId(socket),
    );
    socket.__relayMeta.pendingRoomName = '';
    socket.__relayMeta.pendingRoomId = '';
    emitEvent(socket, 'room_created', {
      roomId: roomData.roomId,
      roomName: roomData.roomName,
      hostPairKey: roomData.hostPairKey,
      guestUrl: roomData.guestUrl,
      extensionWsUrl: roomData.extensionWsUrl,
    });
    logger.info('room.created', {
      ...getSocketContext(socket),
      ...getRoomContext(roomData.roomId),
    });
  }

  function payloadRoomName(socket) {
    return socket.__relayMeta.pendingRoomName || '';
  }

  function payloadRequestedRoomId(socket) {
    return socket.__relayMeta.pendingRoomId || '';
  }

  function handleJoinRoom(socket, payload) {
    const roomId = String(payload.roomId || '').trim();
    const name = String(payload.name || '').trim();
    const role = payload.role === 'admin' ? 'admin' : 'guest';

    if (!roomId) {
      emitError(socket, 'Room ID is required', {}, {
        action: 'join_room',
      });
      return;
    }

    if (!name) {
      emitError(socket, 'Name is required', {}, {
        action: 'join_room',
        roomId,
      });
      return;
    }

    if (role === 'admin' && !socket.__relayMeta.isAdminAuthenticated) {
      emitError(socket, 'Admin authentication required', {}, {
        action: 'join_room',
        roomId,
        role,
      });
      return;
    }

    if (socket.__relayMeta.playerId) {
      emitError(socket, 'Socket is already joined to a room', {}, {
        action: 'join_room',
        roomId,
        role,
      });
      return;
    }

    try {
      const { room, player } = joinRoom(roomId, {
        socketId: socket.__relayMeta.socketId,
        name,
        role,
      });

      socket.__relayMeta.roomId = room.id;
      socket.__relayMeta.playerId = player.id;
      socket.__relayMeta.role = role;

      emitEvent(socket, 'room_joined', {
        roomId: room.id,
        playerId: player.id,
        role,
      });

      logger.info('room.joined', {
        ...getSocketContext(socket),
        playerName: player.name,
        ...getRoomContext(room.id),
      });
      handlePlayerBroadcast(room.id, 'room_joined', {
        actorSocketId: socket.__relayMeta.socketId,
      });
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'join_room',
        roomId,
        role,
      });
      logger.warn('room.join_failed', {
        ...getSocketContext(socket),
        roomId,
        playerName: name,
        role,
        error,
      });
    }
  }

  function handleUpdateDraft(socket, payload) {
    const { roomId, playerId } = socket.__relayMeta;

    if (!roomId || !playerId) {
      emitError(socket, 'Join a room first', {}, {
        action: 'update_draft',
      });
      return;
    }

    try {
      updatePlayerDraft(roomId, playerId, payload.text);
      handlePlayerBroadcast(roomId, 'draft_updated');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'update_draft',
      });
      logger.warn('room.draft_update_failed', {
        ...getSocketContext(socket),
        textLength: String(payload.text || '').length,
        error,
      });
    }
  }

  function handleSetReady(socket, payload) {
    const { roomId, playerId } = socket.__relayMeta;

    if (!roomId || !playerId) {
      emitError(socket, 'Join a room first', {}, {
        action: 'set_ready',
      });
      return;
    }

    try {
      updatePlayerReady(roomId, playerId, payload.ready);
      logger.info('room.ready_updated', {
        ...getSocketContext(socket),
        ready: Boolean(payload.ready),
        ...getRoomContext(roomId),
      });
      handlePlayerBroadcast(roomId, 'ready_updated');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'set_ready',
      });
      logger.warn('room.ready_update_failed', {
        ...getSocketContext(socket),
        ready: Boolean(payload.ready),
        error,
      });
    }
  }

  function handleSendOoc(socket, payload) {
    const { roomId, playerId } = socket.__relayMeta;

    if (!roomId || !playerId) {
      emitError(socket, 'Join a room first', {}, {
        action: 'send_ooc',
      });
      return;
    }

    try {
      appendOocMessage(roomId, playerId, payload.text);
      handlePlayerBroadcast(roomId, 'ooc_sent');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'send_ooc',
      });
      logger.warn('room.ooc_send_failed', {
        ...getSocketContext(socket),
        textLength: String(payload.text || '').length,
        error,
      });
    }
  }

  function handleSetAdminNote(socket, payload) {
    const { roomId, playerId } = socket.__relayMeta;

    if (!roomId || !playerId || socket.__relayMeta.role !== 'admin') {
      emitError(socket, 'Admin room connection required', {}, {
        action: 'set_admin_note',
      });
      return;
    }

    try {
      updateAdminNote(roomId, playerId, payload.text);
      handlePlayerBroadcast(roomId, 'admin_note_updated');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'set_admin_note',
      });
      logger.warn('room.admin_note_update_failed', {
        ...getSocketContext(socket),
        textLength: String(payload.text || '').length,
        error,
      });
    }
  }

  function handleUpdateRenderOptions(socket, payload) {
    const { roomId, playerId } = socket.__relayMeta;

    if (!roomId || !playerId || socket.__relayMeta.role !== 'admin') {
      emitError(socket, 'Admin room connection required', {}, {
        action: 'update_render_options',
      });
      return;
    }

    try {
      updateRenderOptions(roomId, playerId, payload);
      logger.info('room.render_options_updated', {
        ...getSocketContext(socket),
        allowHtml: Boolean(payload.allowHtml),
        allowStyles: Boolean(payload.allowHtml) && Boolean(payload.allowStyles),
        ...getRoomContext(roomId),
      });
      handlePlayerBroadcast(roomId, 'render_options_updated');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'update_render_options',
      });
      logger.warn('room.render_options_update_failed', {
        ...getSocketContext(socket),
        allowHtml: Boolean(payload.allowHtml),
        allowStyles: Boolean(payload.allowStyles),
        error,
      });
    }
  }

  function handleRenamePlayer(socket, payload) {
    const { roomId, playerId } = socket.__relayMeta;

    if (!roomId || !playerId) {
      emitError(socket, 'Join a room first', {}, {
        action: 'rename_player',
      });
      return;
    }

    try {
      renamePlayer(roomId, playerId, payload.name);
      handlePlayerBroadcast(roomId, 'player_renamed');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'rename_player',
      });
      logger.warn('room.player_rename_failed', {
        ...getSocketContext(socket),
        attemptedName: String(payload.name || '').trim(),
        error,
      });
    }
  }

  function handleSendTurn(socket, payload) {
    const { roomId } = socket.__relayMeta;

    if (!roomId || socket.__relayMeta.role !== 'admin') {
      emitError(socket, 'Admin room connection required', {}, {
        action: 'send_turn_to_tavern',
      });
      return;
    }

    try {
      const { room, turnId, message } = startTurn(roomId, {
        force: Boolean(payload.force),
      });

      const hostSocket = getOpenSocketById(room.hostSocketId);

      if (!hostSocket) {
        clearSocketConnection(roomId, room.hostSocketId);
        emitError(socket, 'Tavern extension is not connected', {}, {
          action: 'send_turn_to_tavern',
        });
        logger.warn('room.turn_dispatch_failed', {
          ...getSocketContext(socket),
          force: Boolean(payload.force),
          reason: 'host_socket_not_open',
          ...getRoomContext(roomId),
        });
        handlePlayerBroadcast(roomId, 'turn_dispatch_failed');
        return;
      }

      emitEvent(hostSocket, 'submit_turn', {
        turnId,
        message,
      });

      logger.info('room.turn_dispatched', {
        ...getSocketContext(socket),
        force: Boolean(payload.force),
        turnId,
        messageLength: String(message || '').length,
        hostSocketId: room.hostSocketId,
        ...getRoomContext(roomId),
      });
      handlePlayerBroadcast(roomId, 'turn_dispatched');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'send_turn_to_tavern',
      });
      logger.warn('room.turn_dispatch_failed', {
        ...getSocketContext(socket),
        force: Boolean(payload.force),
        error,
        ...getRoomContext(roomId),
      });
    }
  }

  function handleRegenerateTurn(socket) {
    const { roomId } = socket.__relayMeta;

    if (!roomId || socket.__relayMeta.role !== 'admin') {
      emitError(socket, 'Admin room connection required', {}, {
        action: 'regenerate_in_tavern',
      });
      return;
    }

    try {
      const { room, turnId } = startRegeneration(roomId);
      const hostSocket = getOpenSocketById(room.hostSocketId);

      if (!hostSocket) {
        clearSocketConnection(roomId, room.hostSocketId);
        emitError(socket, 'Tavern extension is not connected', {}, {
          action: 'regenerate_in_tavern',
        });
        logger.warn('room.regeneration_dispatch_failed', {
          ...getSocketContext(socket),
          reason: 'host_socket_not_open',
          ...getRoomContext(roomId),
        });
        handlePlayerBroadcast(roomId, 'regeneration_dispatch_failed');
        return;
      }

      emitEvent(hostSocket, 'regenerate_last', { turnId });
      logger.info('room.regeneration_dispatched', {
        ...getSocketContext(socket),
        turnId,
        hostSocketId: room.hostSocketId,
        ...getRoomContext(roomId),
      });
      handlePlayerBroadcast(roomId, 'regeneration_dispatched');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'regenerate_in_tavern',
      });
      logger.warn('room.regeneration_dispatch_failed', {
        ...getSocketContext(socket),
        error,
        ...getRoomContext(roomId),
      });
    }
  }

  function handleHostGenerationStarted(socket, payload) {
    const { roomId } = socket.__relayMeta;

    if (!roomId || socket.__relayMeta.role !== 'host') {
      logger.warn('host.generation_started.ignored', {
        ...getSocketContext(socket),
        payload: summarizeIncomingPayload('generation_started', payload),
      });
      return;
    }

    try {
      markGenerationStarted(roomId, payload.turnId);
      logger.info('host.generation_started', {
        ...getSocketContext(socket),
        turnId: String(payload.turnId || ''),
        ...getRoomContext(roomId),
      });
      handlePlayerBroadcast(roomId, 'generation_started');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'generation_started',
      });
      logger.warn('host.generation_started.failed', {
        ...getSocketContext(socket),
        turnId: String(payload.turnId || ''),
        error,
      });
    }
  }

  function handleHostGenerationFinished(socket, payload) {
    const { roomId } = socket.__relayMeta;

    if (!roomId || socket.__relayMeta.role !== 'host') {
      logger.warn('host.generation_finished.ignored', {
        ...getSocketContext(socket),
        payload: summarizeIncomingPayload('generation_finished', payload),
      });
      return;
    }

    try {
      finishGeneration(roomId, payload.turnId, payload.reply);
      logger.info('host.generation_finished', {
        ...getSocketContext(socket),
        turnId: String(payload.turnId || ''),
        replyLength: String(payload.reply || '').length,
        ...getRoomContext(roomId),
      });
      handlePlayerBroadcast(roomId, 'generation_finished');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'generation_finished',
      });
      logger.warn('host.generation_finished.failed', {
        ...getSocketContext(socket),
        turnId: String(payload.turnId || ''),
        replyLength: String(payload.reply || '').length,
        error,
      });
    }
  }

  function handleHostGenerationFailed(socket, payload) {
    const { roomId } = socket.__relayMeta;

    if (!roomId || socket.__relayMeta.role !== 'host') {
      logger.warn('host.generation_failed.ignored', {
        ...getSocketContext(socket),
        payload: summarizeIncomingPayload('generation_failed', payload),
      });
      return;
    }

    try {
      failGeneration(roomId, payload.turnId, payload.error);
      logger.warn('host.generation_failed', {
        ...getSocketContext(socket),
        turnId: String(payload.turnId || ''),
        errorText: String(payload.error || ''),
        ...getRoomContext(roomId),
      });
      handlePlayerBroadcast(roomId, 'generation_failed');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'generation_failed',
      });
      logger.warn('host.generation_fail_handler_failed', {
        ...getSocketContext(socket),
        turnId: String(payload.turnId || ''),
        error,
      });
    }
  }

  function handleHostChatSync(socket, payload) {
    const { roomId } = socket.__relayMeta;

    if (!roomId || socket.__relayMeta.role !== 'host') {
      logger.warn('host.chat_sync.ignored', {
        ...getSocketContext(socket),
        payload: summarizeIncomingPayload('sync_chat_history', payload),
      });
      return;
    }

    try {
      replaceGameLog(roomId, payload.entries);
      logger.info('host.chat_synced', {
        ...getSocketContext(socket),
        entriesCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
        entryTypes: summarizeEntryTypes(payload.entries),
        ...getRoomContext(roomId),
      });
      handlePlayerBroadcast(roomId, 'chat_synced');
    } catch (error) {
      emitError(socket, error.message, {}, {
        action: 'sync_chat_history',
      });
      logger.warn('host.chat_sync_failed', {
        ...getSocketContext(socket),
        entriesCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
        error,
      });
    }
  }

  wss.on('connection', (socket, request) => {
    socket.__relayMeta = {
      socketId: uuidv4(),
      roomId: null,
      playerId: null,
      role: null,
      isAdminAuthenticated: false,
      pendingRoomName: '',
      pendingRoomId: '',
    };

    const requestUrl = new URL(request.url, 'http://localhost');

    if (requestUrl.searchParams.get('role') === 'host') {
      connectHost(socket, requestUrl);
    }

    socket.on('message', (rawMessage) => {
      let message;

      try {
        message = parseJsonMessage(rawMessage);
      } catch (error) {
        emitError(socket, error.message, {}, {
          action: 'parse_message',
          rawLength: String(rawMessage || '').length,
        });
        logger.warn('ws.message.parse_failed', {
          ...getSocketContext(socket),
          rawLength: String(rawMessage || '').length,
          error,
        });
        return;
      }

      switch (message.type) {
        case 'join_admin':
          handleJoinAdmin(socket, message.payload);
          break;
        case 'create_room':
          socket.__relayMeta.pendingRoomId = String(message.payload.roomId || '').trim();
          socket.__relayMeta.pendingRoomName = String(message.payload.roomName || '').trim();
          handleCreateRoom(socket);
          break;
        case 'join_room':
          handleJoinRoom(socket, message.payload);
          break;
        case 'update_draft':
          handleUpdateDraft(socket, message.payload);
          break;
        case 'set_ready':
          handleSetReady(socket, message.payload);
          break;
        case 'send_ooc':
          handleSendOoc(socket, message.payload);
          break;
        case 'set_admin_note':
          handleSetAdminNote(socket, message.payload);
          break;
        case 'update_render_options':
          handleUpdateRenderOptions(socket, message.payload);
          break;
        case 'rename_player':
          handleRenamePlayer(socket, message.payload);
          break;
        case 'send_turn_to_tavern':
          handleSendTurn(socket, message.payload);
          break;
        case 'regenerate_in_tavern':
          handleRegenerateTurn(socket);
          break;
        case 'generation_started':
          handleHostGenerationStarted(socket, message.payload);
          break;
        case 'generation_finished':
          handleHostGenerationFinished(socket, message.payload);
          break;
        case 'generation_failed':
          handleHostGenerationFailed(socket, message.payload);
          break;
        case 'sync_chat_history':
          handleHostChatSync(socket, message.payload);
          break;
        default:
          emitError(socket, `Unknown event: ${message.type}`, {}, {
            action: 'dispatch_message',
            type: message.type,
          });
          logger.warn('ws.message.unknown_type', {
            ...getSocketContext(socket),
            type: message.type,
          });
          break;
      }
    });

    socket.on('error', (error) => {
      logger.error('ws.connection.error', {
        ...getSocketContext(socket),
        error,
      });
    });

    socket.on('close', (code, reasonBuffer) => {
      const { roomId, role, socketId } = socket.__relayMeta || {};
      const reason = reasonBuffer ? String(reasonBuffer) : '';

      if (!roomId) {
        return;
      }

      const playerId = socket.__relayMeta?.playerId || null;
      clearSocketConnection(roomId, socketId);

      if (role === 'host') {
        logger.warn('ws.host_disconnected', {
          socketId,
          roomId,
          closeCode: code,
          closeReason: reason || null,
          ...getRoomContext(roomId),
        });
      } else {
        logger.info('room.player_disconnected', {
          socketId,
          roomId,
          playerId,
          role,
          closeCode: code,
          closeReason: reason || null,
          ...getRoomContext(roomId),
        });
      }

      if (role !== 'host' && rooms.has(roomId)) {
        handlePlayerBroadcast(roomId, 'socket_closed', {
          closedSocketId: socketId,
          closedRole: role,
        });
        return;
      }

      if (rooms.has(roomId)) {
        handlePlayerBroadcast(roomId, 'host_socket_closed', {
          closedSocketId: socketId,
          closedRole: role,
        });
      }
    });
  });

  return wss;
}

module.exports = {
  attachWebSocketServer,
};
