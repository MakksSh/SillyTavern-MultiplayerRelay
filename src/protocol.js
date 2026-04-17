function parseJsonMessage(rawMessage) {
  let parsed;

  try {
    parsed = JSON.parse(String(rawMessage));
  } catch (error) {
    throw new Error('Invalid JSON message');
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    throw new Error('Invalid message envelope');
  }

  return {
    type: parsed.type,
    payload: parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {},
  };
}

function sendEvent(socket, type, payload = {}) {
  if (!socket || socket.readyState !== 1) {
    return;
  }

  socket.send(JSON.stringify({ type, payload }));
}

function sendError(socket, message, details = {}) {
  sendEvent(socket, 'error', {
    message,
    ...details,
  });
}

function createGuestUrl(publicBaseUrl, roomId) {
  return new URL(`/room/${roomId}`, publicBaseUrl).toString();
}

function createExtensionWsUrl(publicBaseUrl, roomId, hostPairKey) {
  const publicUrl = new URL(publicBaseUrl);
  publicUrl.protocol = publicUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  publicUrl.pathname = '/ws';
  publicUrl.search = '';
  publicUrl.searchParams.set('role', 'host');
  publicUrl.searchParams.set('roomId', roomId);
  publicUrl.searchParams.set('hostPairKey', hostPairKey);
  return publicUrl.toString();
}

module.exports = {
  parseJsonMessage,
  sendEvent,
  sendError,
  createGuestUrl,
  createExtensionWsUrl,
};
