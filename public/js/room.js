(function () {
  const common = window.RelayCommon;
  const roomId = decodeURIComponent(window.location.pathname.split('/').pop() || '');
  const state = {
    socket: null,
    reconnectTimer: null,
    joined: false,
    selfPlayerId: '',
    roomStatus: 'waiting_host',
    draftState: {
      hasUnacknowledged: false,
    },
    renderOptions: {
      allowHtml: false,
      allowStyles: false,
    },
  };

  const elements = {
    draftInput: document.getElementById('draftInput'),
    draftNotice: document.getElementById('draftNotice'),
    draftNoticeText: document.getElementById('draftNoticeText'),
    gameLog: document.getElementById('gameLog'),
    guestName: document.getElementById('guestName'),
    guestToolsDrawer: document.getElementById('guestToolsDrawer'),
    hostStatusText: document.getElementById('hostStatusText'),
    joinButton: document.getElementById('joinButton'),
    joinPanel: document.getElementById('joinPanel'),
    joinStatus: document.getElementById('joinStatus'),
    oocForm: document.getElementById('oocForm'),
    oocInput: document.getElementById('oocInput'),
    oocLog: document.getElementById('oocLog'),
    pageAlert: document.getElementById('pageAlert'),
    playersList: document.getElementById('playersList'),
    profileNameInput: document.getElementById('profileNameInput'),
    profilePanel: document.getElementById('profilePanel'),
    readyButton: document.getElementById('readyButton'),
    renameButton: document.getElementById('renameButton'),
    roomHeading: document.getElementById('roomHeading'),
    roomIdField: document.getElementById('roomIdField'),
    roomStatusLabel: document.getElementById('roomStatusLabel'),
    roomStatusText: document.getElementById('roomStatusText'),
    roomSubheading: document.getElementById('roomSubheading'),
    wsStatus: document.getElementById('wsStatus'),
  };

  elements.roomIdField.value = roomId;
  elements.guestName.value = common.readQuery('name');
  elements.profileNameInput.value = elements.guestName.value;

  function updateRoomMeta(roomName) {
    const normalizedRoomName = String(roomName || '').trim() || 'Комната';
    elements.roomHeading.textContent = normalizedRoomName;
    elements.roomSubheading.textContent = roomId
      ? 'Совместная игровая комната в Relay.'
      : 'Подключение к Relay...';
    document.title = `${normalizedRoomName} | Relay Room`;
  }

  const syncDraft = common.debounce(() => {
    if (!state.joined) {
      return;
    }

    common.sendEvent(state.socket, 'update_draft', {
      text: elements.draftInput.value,
    });
  }, 250);

  function showError(message) {
    common.showAlert(elements.pageAlert, message);
  }

  function clearError() {
    common.showAlert(elements.pageAlert, '');
  }

  function applyRenderOptions(renderOptions = {}) {
    const allowHtml = Boolean(renderOptions.allowHtml);
    state.renderOptions = {
      allowHtml,
      allowStyles: allowHtml && Boolean(renderOptions.allowStyles),
    };
  }

  function setDraftLocked(locked) {
    elements.draftInput.disabled = Boolean(locked);
  }

  function updateDraftNotice(statePayload, selfPlayer) {
    let tone = 'neutral';
    let text = 'Можно редактировать draft. Когда будете готовы, нажмите Ready.';
    let isBusy = false;
    let isRegenerate = false;

    if (!statePayload.hostConnected) {
      tone = 'danger';
      text = 'SillyTavern сейчас не подключён. Draft можно готовить, но генерация недоступна.';
    } else if (statePayload.status === 'generating') {
      tone = 'warn';
      isBusy = true;
      isRegenerate = statePayload.turnKind === 'regenerate';
      text = statePayload.turnKind === 'regenerate'
        ? 'В Tavern идёт регенерация последнего ответа. Дождитесь обновления Game Log.'
        : 'В Tavern идёт генерация ответа по готовым draft. Дождитесь обновления Game Log.';
    } else if (selfPlayer?.ready) {
      tone = 'ok';
      text = 'Ваш draft зафиксирован. Снимите Ready, если нужно внести правки.';
    }

    elements.draftNoticeText.textContent = text;
    elements.draftNotice.className = `draft-notice draft-notice-${tone}${isBusy ? ' is-busy' : ''}${isRegenerate ? ' is-regenerate' : ''}`;
  }

  function revealJoinedUi() {
    elements.joinPanel.classList.add('d-none');
    elements.profilePanel.classList.remove('d-none');
  }

  function applyRemoteInputValue(input, syncState, value) {
    const normalizedValue = String(value || '');

    if (input.value === normalizedValue) {
      syncState.hasUnacknowledged = false;
      return;
    }

    if (syncState.hasUnacknowledged) {
      return;
    }

    input.value = normalizedValue;
  }

  function tryJoin() {
    const name = (elements.profilePanel.classList.contains('d-none')
      ? elements.guestName.value
      : elements.profileNameInput.value).trim();

    if (!name) {
      return;
    }

    elements.profileNameInput.value = name;
    common.sendEvent(state.socket, 'join_room', {
      roomId,
      name,
      role: 'guest',
    });
  }

  function renameSelf() {
    if (!state.joined) {
      showError('Нужно сначала присоединиться к комнате.');
      return;
    }

    const name = elements.profileNameInput.value.trim();
    if (!name) {
      showError('Имя не может быть пустым.');
      return;
    }

    clearError();
    common.sendEvent(state.socket, 'rename_player', { name });
  }

  function updateRoomState(statePayload) {
    updateRoomMeta(statePayload.roomName);
    state.roomStatus = statePayload.status || 'waiting_host';
    const statusMeta = common.describeRoomStatus(statePayload.status);
    common.setStatusPill(elements.roomStatusLabel, statusMeta.label, statusMeta.tone);
    elements.roomStatusText.textContent = statePayload.status;
    elements.hostStatusText.textContent = statePayload.hostConnected ? 'connected' : 'not connected';

    const selfPlayer = statePayload.players.find((player) => player.id === statePayload.selfPlayerId);
    if (selfPlayer) {
      elements.readyButton.textContent = selfPlayer.ready ? 'Not Ready' : 'Ready';
      elements.profileNameInput.value = selfPlayer.name || elements.profileNameInput.value;
      applyRemoteInputValue(elements.draftInput, state.draftState, selfPlayer.draft);
      setDraftLocked(selfPlayer.ready);
    } else {
      setDraftLocked(true);
    }

    updateDraftNotice(statePayload, selfPlayer);
    applyRenderOptions(statePayload.renderOptions);

    common.renderPlayers(elements.playersList, statePayload.players, statePayload.selfPlayerId, true);
    common.renderLog(elements.gameLog, statePayload.gameLog, 'История хода пока пуста.', state.renderOptions);
    common.renderChat(elements.oocLog, statePayload.oocLog, 'OOC-сообщений пока нет.');
  }

  function handleSocketMessage(event) {
    const message = JSON.parse(event.data);

    switch (message.type) {
      case 'room_joined':
        state.joined = true;
        state.selfPlayerId = message.payload.playerId;
        clearError();
        common.setStatusPill(elements.joinStatus, 'Joined', 'ok');
        revealJoinedUi();
        break;
      case 'room_state':
        updateRoomState(message.payload);
        break;
      case 'error':
        showError(message.payload.message || 'Unknown relay error');
        break;
      default:
        break;
    }
  }

  function connectSocket() {
    state.socket = common.createSocket();

    state.socket.addEventListener('open', () => {
      common.setStatusPill(elements.wsStatus, 'WS online', 'ok');
      if (elements.guestName.value.trim()) {
        tryJoin();
      }
    });

    state.socket.addEventListener('message', handleSocketMessage);

    state.socket.addEventListener('close', () => {
      state.joined = false;
      state.selfPlayerId = '';
      state.roomStatus = 'waiting_host';
      setDraftLocked(true);
      updateDraftNotice({
        hostConnected: false,
        status: 'waiting_host',
        turnKind: null,
      }, null);
      common.setStatusPill(elements.wsStatus, 'WS offline', 'danger');
      common.setStatusPill(elements.joinStatus, 'Disconnected', 'warn');

      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = window.setTimeout(connectSocket, 1500);
    });
  }

  elements.joinButton.addEventListener('click', () => {
    if (!roomId) {
      showError('Room ID is missing in URL.');
      return;
    }

    const name = elements.guestName.value.trim();
    if (!name) {
      showError('Введите имя перед входом.');
      return;
    }

    elements.profileNameInput.value = name;
    clearError();
    tryJoin();
  });

  elements.renameButton.addEventListener('click', renameSelf);
  elements.profileNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      renameSelf();
    }
  });

  elements.readyButton.addEventListener('click', () => {
    if (!state.joined) {
      showError('Нужно сначала присоединиться к комнате.');
      return;
    }

    const shouldBeReady = elements.readyButton.textContent === 'Ready';
    if (shouldBeReady) {
      common.sendEvent(state.socket, 'update_draft', {
        text: elements.draftInput.value,
      });
      state.draftState.hasUnacknowledged = false;
    }
    common.sendEvent(state.socket, 'set_ready', { ready: shouldBeReady });
  });

  elements.draftInput.addEventListener('input', syncDraft);
  elements.draftInput.addEventListener('input', () => {
    state.draftState.hasUnacknowledged = true;
  });

  elements.oocForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = elements.oocInput.value.trim();

    if (!text) {
      return;
    }

    common.sendEvent(state.socket, 'send_ooc', { text });
    elements.oocInput.value = '';
  });

  updateRoomMeta('');
  setDraftLocked(true);
  updateDraftNotice({
    hostConnected: false,
    status: 'waiting_host',
    turnKind: null,
  }, null);
  connectSocket();
})();
