(function () {
  const common = window.RelayCommon;
  const STORAGE_KEYS = {
    adminBootstrapKey: 'relay.admin.bootstrapKey',
    adminName: 'relay.admin.name',
    adminSessionToken: 'relay.admin.sessionToken',
  };
  const state = {
    socket: null,
    reconnectTimer: null,
    authenticated: false,
    adminSessionToken: '',
    bootstrapAdminKey: '',
    roomId: '',
    playerId: '',
    roomStatus: 'waiting_host',
    turnAction: '',
    draftState: {
      hasUnacknowledged: false,
    },
    adminNoteState: {
      hasUnacknowledged: false,
    },
    renderOptions: {
      allowHtml: false,
      allowStyles: false,
    },
  };

  const elements = {
    adminDraft: document.getElementById('adminDraft'),
    adminKey: document.getElementById('adminKey'),
    adminNote: document.getElementById('adminNote'),
    adminReadyButton: document.getElementById('adminReadyButton'),
    adminToolsDrawer: document.getElementById('adminToolsDrawer'),
    allowHtmlToggle: document.getElementById('allowHtmlToggle'),
    allowStylesToggle: document.getElementById('allowStylesToggle'),
    authStatus: document.getElementById('authStatus'),
    createRoomButton: document.getElementById('createRoomButton'),
    customRoomIdInput: document.getElementById('customRoomIdInput'),
    extensionWsUrlField: document.getElementById('extensionWsUrlField'),
    forceSendButton: document.getElementById('forceSendButton'),
    gameLog: document.getElementById('gameLog'),
    guestUrlField: document.getElementById('guestUrlField'),
    hostStatusText: document.getElementById('hostStatusText'),
    loginAdminName: document.getElementById('loginAdminName'),
    loginButton: document.getElementById('loginButton'),
    loginPanel: document.getElementById('loginPanel'),
    oocForm: document.getElementById('oocForm'),
    oocInput: document.getElementById('oocInput'),
    oocLog: document.getElementById('oocLog'),
    pageAlert: document.getElementById('pageAlert'),
    playersList: document.getElementById('playersList'),
    profileNameInput: document.getElementById('profileNameInput'),
    profilePanel: document.getElementById('profilePanel'),
    regenerateTurnButton: document.getElementById('regenerateTurnButton'),
    renameButton: document.getElementById('renameButton'),
    roomHeading: document.getElementById('roomHeading'),
    roomIdField: document.getElementById('roomIdField'),
    roomNameInput: document.getElementById('roomNameInput'),
    roomStatusLabel: document.getElementById('roomStatusLabel'),
    roomSubheading: document.getElementById('roomSubheading'),
    sendTurnButton: document.getElementById('sendTurnButton'),
    wsStatus: document.getElementById('wsStatus'),
  };

  function readSessionValue(key) {
    try {
      return window.sessionStorage.getItem(key) || '';
    } catch (_error) {
      return '';
    }
  }

  function writeSessionValue(key, value) {
    try {
      if (value) {
        window.sessionStorage.setItem(key, value);
      } else {
        window.sessionStorage.removeItem(key);
      }
    } catch (_error) {
      // Ignore storage failures and continue with in-memory state.
    }
  }

  function clearSensitiveQueryParams() {
    const nextUrl = new URL(window.location.href);
    let changed = false;

    ['adminKey', 'name'].forEach((key) => {
      if (nextUrl.searchParams.has(key)) {
        nextUrl.searchParams.delete(key);
        changed = true;
      }
    });

    if (changed) {
      const nextSearch = nextUrl.searchParams.toString();
      const nextPath = `${nextUrl.pathname}${nextSearch ? `?${nextSearch}` : ''}${nextUrl.hash}`;
      window.history.replaceState({}, document.title, nextPath);
    }
  }

  function migrateLegacyAdminQuery() {
    const legacyAdminKey = common.readQuery('adminKey').trim();
    const legacyAdminName = common.readQuery('name').trim();

    if (legacyAdminKey && !state.bootstrapAdminKey) {
      setBootstrapAdminKey(legacyAdminKey);
    }

    if (legacyAdminName && !readSessionValue(STORAGE_KEYS.adminName)) {
      writeSessionValue(STORAGE_KEYS.adminName, legacyAdminName);
    }

    clearSensitiveQueryParams();
  }

  function setAdminSessionToken(token) {
    state.adminSessionToken = String(token || '').trim();
    writeSessionValue(STORAGE_KEYS.adminSessionToken, state.adminSessionToken);
  }

  function setBootstrapAdminKey(adminKey) {
    state.bootstrapAdminKey = String(adminKey || '').trim();
    writeSessionValue(STORAGE_KEYS.adminBootstrapKey, state.bootstrapAdminKey);
  }

  function saveAdminName(name) {
    writeSessionValue(STORAGE_KEYS.adminName, String(name || '').trim());
  }

  function getStoredAdminName() {
    return readSessionValue(STORAGE_KEYS.adminName).trim();
  }

  function getManualAdminKey() {
    return elements.adminKey.value.trim();
  }

  function buildAdminAuthPayload(preferredAdminKey = '') {
    const manualAdminKey = String(preferredAdminKey || '').trim();
    if (manualAdminKey) {
      return { adminKey: manualAdminKey };
    }

    if (state.adminSessionToken) {
      return { sessionToken: state.adminSessionToken };
    }

    const adminKey = String(state.bootstrapAdminKey || '').trim();
    if (!adminKey) {
      return null;
    }

    return { adminKey };
  }

  function requestAdminAuth(preferredAdminKey = '') {
    const payload = buildAdminAuthPayload(preferredAdminKey);
    if (!payload) {
      return false;
    }

    return common.sendEvent(state.socket, 'join_admin', payload);
  }

  state.adminSessionToken = readSessionValue(STORAGE_KEYS.adminSessionToken).trim();
  state.bootstrapAdminKey = readSessionValue(STORAGE_KEYS.adminBootstrapKey).trim();
  migrateLegacyAdminQuery();
  elements.customRoomIdInput.value = common.readQuery('roomId');
  elements.loginAdminName.value = getStoredAdminName() || elements.loginAdminName.value;
  elements.profileNameInput.value = elements.loginAdminName.value;
  elements.roomNameInput.value = common.readQuery('roomName');
  common.wireCopyButtons();
  const actionButtonDefaults = new Map([
    [elements.sendTurnButton, 'Send to Tavern'],
    [elements.forceSendButton, 'Force Send'],
    [elements.regenerateTurnButton, 'Regenerate'],
  ]);

  const syncDraft = common.debounce(() => {
    if (!state.playerId) {
      return;
    }

    common.sendEvent(state.socket, 'update_draft', {
      text: elements.adminDraft.value,
    });
  }, 250);

  const syncAdminNote = common.debounce(() => {
    if (!state.playerId) {
      return;
    }

    common.sendEvent(state.socket, 'set_admin_note', {
      text: elements.adminNote.value,
    });
  }, 250);

  function showError(message) {
    common.showAlert(elements.pageAlert, message);
  }

  function clearError() {
    common.showAlert(elements.pageAlert, '');
  }

  function setDraftLocked(locked) {
    elements.adminDraft.disabled = Boolean(locked);
  }

  function setAdminNoteLocked(locked) {
    elements.adminNote.disabled = Boolean(locked);
  }

  function applyRenderOptions(renderOptions = {}) {
    const allowHtml = Boolean(renderOptions.allowHtml);
    const allowStyles = allowHtml && Boolean(renderOptions.allowStyles);
    state.renderOptions = {
      allowHtml,
      allowStyles,
    };

    elements.allowHtmlToggle.checked = allowHtml;
    elements.allowStylesToggle.checked = allowStyles;
    elements.allowStylesToggle.disabled = !allowHtml;
  }

  function syncRenderOptions() {
    if (!state.playerId) {
      return;
    }

    const allowHtml = elements.allowHtmlToggle.checked;
    const allowStyles = allowHtml && elements.allowStylesToggle.checked;
    common.sendEvent(state.socket, 'update_render_options', {
      allowHtml,
      allowStyles,
    });
  }

  function setActionButtonState(button, label, loading) {
    if (!button) {
      return;
    }

    if (!loading) {
      button.textContent = label;
      button.classList.remove('btn-with-spinner');
      return;
    }

    button.classList.add('btn-with-spinner');
    button.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span><span></span>';
    button.lastElementChild.textContent = label;
  }

  function updateActionButtons() {
    const busy = state.roomStatus === 'generating' || Boolean(state.turnAction);
    const canRunActions = Boolean(state.playerId);

    for (const [button, label] of actionButtonDefaults.entries()) {
      const isLoading =
        (button === elements.sendTurnButton && state.turnAction === 'send') ||
        (button === elements.forceSendButton && state.turnAction === 'force') ||
        (button === elements.regenerateTurnButton && state.turnAction === 'regenerate');

      const loadingLabel = button === elements.regenerateTurnButton ? 'Regenerating...' : 'Sending...';
      setActionButtonState(button, isLoading ? loadingLabel : label, isLoading);
      button.disabled = !canRunActions || busy;
    }
  }

  function startTurnAction(action) {
    state.turnAction = action;
    updateActionButtons();
  }

  function finishTurnAction() {
    state.turnAction = '';
    updateActionButtons();
  }

  function getDesiredName() {
    return (elements.profilePanel.classList.contains('d-none')
      ? elements.loginAdminName.value
      : elements.profileNameInput.value).trim();
  }

  function revealJoinedUi() {
    elements.loginPanel.classList.add('d-none');
    elements.profilePanel.classList.remove('d-none');
  }

  function updateRoomMeta(roomId, roomName) {
    const normalizedRoomName = String(roomName || '').trim() || 'Новая комната';
    elements.roomHeading.textContent = normalizedRoomName;
    elements.roomSubheading.textContent = String(roomId || state.roomId || '').trim()
      ? 'Комната активна. Ссылки и ID доступны в инструментах справа.'
      : 'Создайте комнату и подключите SillyTavern к Relay.';
    document.title = `${normalizedRoomName} | Relay Admin`;
  }

  function getRequestedRoomId() {
    return elements.customRoomIdInput.value.trim();
  }

  function validateRequestedRoomId() {
    const requestedRoomId = getRequestedRoomId();
    if (!requestedRoomId) {
      return true;
    }

    if (!/^[A-Za-z0-9]+$/.test(requestedRoomId)) {
      showError('Custom Room ID может содержать только латиницу и цифры.');
      return false;
    }

    return true;
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

  function updateRoomStatus(statePayload) {
    updateRoomMeta(statePayload.roomId, statePayload.roomName);
    state.roomStatus = statePayload.status || 'waiting_host';
    if (state.roomStatus !== 'generating') {
      finishTurnAction();
    } else {
      updateActionButtons();
    }
    const statusMeta = common.describeRoomStatus(statePayload.status);
    common.setStatusPill(elements.roomStatusLabel, statusMeta.label, statusMeta.tone);
    elements.hostStatusText.textContent = statePayload.hostConnected ? 'connected' : 'not connected';

    const selfPlayer = statePayload.players.find((player) => player.id === statePayload.selfPlayerId);
    if (selfPlayer) {
      elements.adminReadyButton.textContent = selfPlayer.ready ? 'Not Ready' : 'Ready';
      elements.profileNameInput.value = selfPlayer.name || elements.profileNameInput.value;
      saveAdminName(elements.profileNameInput.value);
      applyRemoteInputValue(elements.adminDraft, state.draftState, selfPlayer.draft);
      setDraftLocked(selfPlayer.ready);
      setAdminNoteLocked(selfPlayer.ready);
    } else {
      setDraftLocked(true);
      setAdminNoteLocked(true);
    }

    applyRemoteInputValue(elements.adminNote, state.adminNoteState, statePayload.adminNote);
    applyRenderOptions(statePayload.renderOptions);

    common.renderPlayers(elements.playersList, statePayload.players, statePayload.selfPlayerId, true);
    common.renderLog(elements.gameLog, statePayload.gameLog, 'История хода появится после первой генерации.', state.renderOptions);
    common.renderChat(elements.oocLog, statePayload.oocLog, 'OOC-сообщений пока нет.');
  }

  function joinAdminRoom() {
    if (!state.roomId) {
      showError('Сначала создайте комнату.');
      return;
    }

    const name = getDesiredName();
    if (!name) {
      showError('Укажите имя администратора.');
      return;
    }

    elements.profileNameInput.value = name;
    common.sendEvent(state.socket, 'join_room', {
      roomId: state.roomId,
      name,
      role: 'admin',
    });
  }

  function renameSelf() {
    if (!state.playerId) {
      showError('Нужно сначала подключиться к комнате.');
      return;
    }

    const name = elements.profileNameInput.value.trim();
    if (!name) {
      showError('Имя не может быть пустым.');
      return;
    }

    clearError();
    saveAdminName(name);
    common.sendEvent(state.socket, 'rename_player', { name });
  }

  function handleSocketMessage(event) {
    const message = JSON.parse(event.data);

    switch (message.type) {
      case 'admin_joined':
        state.authenticated = true;
        setAdminSessionToken(message.payload.sessionToken);
        setBootstrapAdminKey('');
        elements.adminKey.value = '';
        clearError();
        common.setStatusPill(elements.authStatus, 'Unlocked', 'ok');
        elements.profileNameInput.value = elements.loginAdminName.value.trim() || elements.profileNameInput.value;
        saveAdminName(elements.profileNameInput.value);
        elements.loginPanel.classList.add('d-none');
        elements.profilePanel.classList.remove('d-none');
        if (state.roomId && !state.playerId) {
          joinAdminRoom();
        }
        break;
      case 'room_created':
        state.roomId = message.payload.roomId;
        state.playerId = '';
        elements.createRoomButton.disabled = true;
        elements.createRoomButton.textContent = 'Комната создана';
        elements.customRoomIdInput.disabled = true;
        elements.roomNameInput.disabled = true;
        elements.roomIdField.value = message.payload.roomId || '';
        elements.customRoomIdInput.value = message.payload.roomId || elements.customRoomIdInput.value;
        elements.guestUrlField.value = message.payload.guestUrl || '';
        elements.extensionWsUrlField.value = message.payload.extensionWsUrl || '';
        elements.roomNameInput.value = message.payload.roomName || elements.roomNameInput.value;
        updateRoomMeta(message.payload.roomId, message.payload.roomName);
        joinAdminRoom();
        break;
      case 'room_joined':
        state.roomId = message.payload.roomId;
        state.playerId = message.payload.playerId;
        clearError();
        revealJoinedUi();
        updateActionButtons();
        break;
      case 'room_state':
        updateRoomStatus(message.payload);
        break;
      case 'error':
        finishTurnAction();
        if (message.payload.code === 'invalid_admin_session') {
          state.authenticated = false;
          setAdminSessionToken('');
          common.setStatusPill(elements.authStatus, 'Locked', 'warn');
        }
        if (message.payload.code === 'invalid_admin_key') {
          setBootstrapAdminKey('');
        }
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
      clearError();
      requestAdminAuth();
    });

    state.socket.addEventListener('message', handleSocketMessage);

    state.socket.addEventListener('close', () => {
      state.authenticated = false;
      state.playerId = '';
      state.roomStatus = 'waiting_host';
      finishTurnAction();
      common.setStatusPill(elements.wsStatus, 'WS offline', 'danger');
      common.setStatusPill(elements.authStatus, 'Locked', 'warn');

      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = window.setTimeout(connectSocket, 1500);
    });
  }

  elements.loginButton.addEventListener('click', () => {
    const manualAdminKey = getManualAdminKey();
    if (!buildAdminAuthPayload(manualAdminKey)) {
      showError('Введите Admin Key.');
      return;
    }

    const desiredName = elements.loginAdminName.value.trim() || elements.profileNameInput.value;
    elements.profileNameInput.value = desiredName;
    saveAdminName(desiredName);
    clearError();

    if (!requestAdminAuth(manualAdminKey)) {
      showError('Relay socket is not connected.');
    }
  });

  elements.createRoomButton.addEventListener('click', () => {
    if (!state.authenticated) {
      showError('Сначала выполните вход как admin.');
      return;
    }

    if (!validateRequestedRoomId()) {
      return;
    }

    clearError();
    common.sendEvent(state.socket, 'create_room', {
      roomId: getRequestedRoomId(),
      roomName: elements.roomNameInput.value.trim(),
    });
  });

  elements.customRoomIdInput.addEventListener('input', () => {
    const sanitized = elements.customRoomIdInput.value.replace(/[^A-Za-z0-9]/g, '');
    if (sanitized !== elements.customRoomIdInput.value) {
      elements.customRoomIdInput.value = sanitized;
    }
  });

  elements.allowHtmlToggle.addEventListener('change', () => {
    if (!elements.allowHtmlToggle.checked) {
      elements.allowStylesToggle.checked = false;
    }
    syncRenderOptions();
  });

  elements.allowStylesToggle.addEventListener('change', () => {
    if (elements.allowStylesToggle.checked) {
      elements.allowHtmlToggle.checked = true;
    }
    syncRenderOptions();
  });

  elements.renameButton.addEventListener('click', renameSelf);
  elements.loginAdminName.addEventListener('input', () => {
    saveAdminName(elements.loginAdminName.value);
  });
  elements.profileNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      renameSelf();
    }
  });

  elements.adminReadyButton.addEventListener('click', () => {
    if (!state.playerId) {
      showError('Нужно сначала присоединиться к комнате.');
      return;
    }

    const shouldBeReady = elements.adminReadyButton.textContent === 'Ready';
    if (shouldBeReady) {
      common.sendEvent(state.socket, 'update_draft', {
        text: elements.adminDraft.value,
      });
      state.draftState.hasUnacknowledged = false;
      common.sendEvent(state.socket, 'set_admin_note', {
        text: elements.adminNote.value,
      });
      state.adminNoteState.hasUnacknowledged = false;
    }
    common.sendEvent(state.socket, 'set_ready', { ready: shouldBeReady });
  });

  elements.sendTurnButton.addEventListener('click', () => {
    if (!state.playerId || state.roomStatus === 'generating') {
      return;
    }

    clearError();
    startTurnAction('send');
    if (!common.sendEvent(state.socket, 'send_turn_to_tavern', { force: false })) {
      finishTurnAction();
      showError('Relay socket is not connected.');
    }
  });

  elements.regenerateTurnButton.addEventListener('click', () => {
    if (!state.playerId || state.roomStatus === 'generating') {
      return;
    }

    clearError();
    startTurnAction('regenerate');
    if (!common.sendEvent(state.socket, 'regenerate_in_tavern', {})) {
      finishTurnAction();
      showError('Relay socket is not connected.');
    }
  });

  elements.forceSendButton.addEventListener('click', () => {
    if (!state.playerId || state.roomStatus === 'generating') {
      return;
    }

    clearError();
    startTurnAction('force');
    if (!common.sendEvent(state.socket, 'send_turn_to_tavern', { force: true })) {
      finishTurnAction();
      showError('Relay socket is not connected.');
    }
  });

  elements.adminDraft.addEventListener('input', syncDraft);
  elements.adminDraft.addEventListener('input', () => {
    state.draftState.hasUnacknowledged = true;
  });
  elements.adminNote.addEventListener('input', syncAdminNote);
  elements.adminNote.addEventListener('input', () => {
    state.adminNoteState.hasUnacknowledged = true;
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

  updateRoomMeta('', elements.roomNameInput.value);
  setDraftLocked(true);
  setAdminNoteLocked(true);
  applyRenderOptions(state.renderOptions);
  updateActionButtons();
  connectSocket();
})();
