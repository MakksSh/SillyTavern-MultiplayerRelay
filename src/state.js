const { v4: uuidv4 } = require('uuid');

const rooms = new Map();

function createRoomRecord({ id = uuidv4(), hostPairKey = uuidv4(), createdAt = Date.now(), name = '' } = {}) {
  return {
    id,
    name: String(name || '').trim() || 'Новая комната',
    hostPairKey,
    createdAt,
    status: 'waiting_host',
    adminSocketId: null,
    hostSocketId: null,
    players: new Map(),
    gameLog: [],
    oocLog: [],
    renderOptions: {
      allowHtml: false,
      allowStyles: false,
    },
    currentTurn: {
      adminNote: '',
      activeTurnId: null,
      kind: null,
      submittedMessage: '',
    },
  };
}

function createPlayerRecord({ socketId, name, role }) {
  return {
    id: uuidv4(),
    socketId,
    name,
    role,
    ready: false,
    draft: '',
    connected: true,
    joinedAt: Date.now(),
  };
}

module.exports = {
  rooms,
  createRoomRecord,
  createPlayerRecord,
};
